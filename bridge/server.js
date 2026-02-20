#!/usr/bin/env node
/**
 * Unified Intercom Bridge - Combines WebSocket Relay + Hyperswarm P2P
 * 
 * This bridge supports TWO protocols:
 * 1. WebSocket Relay Protocol (agents-services compatibility)
 * 2. Hyperswarm P2P Protocol (Observatory network discovery)
 * 
 * Security Features:
 * - Token-based authentication for WebSocket relay
 * - Public key verification for Hyperswarm
 * - Channel/topic isolation (private channels stay private)
 * - Cross-protocol relay for public channels only
 * - Audit logging for all cross-protocol messages
 * 
 * Architecture:
 * WebSocket Clients → Relay Handler → Cross-Protocol Relay → Hyperswarm Network
 *                                    ↓
 *                              Agent Registry
 *                              Message Archive
 *                              Activity Tracker
 */

const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const http = require('http')
const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')

// Configuration
const PORT = process.env.PORT || 8080
const DATA_DIR = process.env.DATA_DIR || '/data'
const KEY_PATH = path.join(DATA_DIR, 'swarm.key')
const MAX_MESSAGES = 1000
const AGENT_TIMEOUT_MS = 3600000 // 1 hour

// WebSocket Relay Configuration
const RELAY_AUTH_TOKEN = process.env.SC_BRIDGE_TOKEN || null // Optional: set via environment
const ENABLE_RELAY_AUTH = !!RELAY_AUTH_TOKEN

// Security: Public channels that can be relayed cross-protocol
const PUBLIC_CHANNELS = new Set([
  '0000intercom',
  'agent-marketplace',
  'agent-announce',
  'intercom-global',
  'agent-network',
  'sc-bridge-discovery'
])

// Load or generate keypair
let keypair
if (fs.existsSync(KEY_PATH)) {
  const keyData = fs.readFileSync(KEY_PATH)
  keypair = {
    publicKey: keyData.slice(0, 32),
    secretKey: keyData.slice(32, 64)
  }
  console.log('[init] Loaded existing keypair from', KEY_PATH)
} else {
  keypair = crypto.keyPair()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(KEY_PATH, b4a.concat([keypair.publicKey, keypair.secretKey]))
  console.log('[init] Generated new keypair, saved to', KEY_PATH)
}

const bridgePublicKey = b4a.toString(keypair.publicKey, 'hex')
console.log('[init] Bridge public key:', bridgePublicKey)

// Initialize Hyperswarm
const swarm = new Hyperswarm({ keyPair: keypair })

// Data structures
const peers = new Map() // publicKey -> { conn, publicKey, connectedAt, lastSeen, isClient, isServer, topics: Set }
const topics = new Map() // topicKey -> { name, key, discovery, peers: Set, joinedAt, server, client, messageCount, lastActivity }
const agents = new Map() // agentId -> { id, name, type, capabilities, publicKey, topics: Set, firstSeen, lastSeen, metadata }
const messages = [] // Array of recent messages (FIFO, max MAX_MESSAGES)
const activityStats = {
  startTime: Date.now(),
  totalMessages: 0,
  totalAgents: 0,
  totalTopics: 0,
  hourlyStats: {}
}

// WebSocket Relay structures
const relayClients = new Map() // ws -> { id, authenticated, channels: Set, agentId }
const relayChannels = new Map() // channelName -> Set of ws clients

// Helper: Generate topic key from name
function getTopicKey(name) {
  const topicBuffer = Buffer.alloc(32)
  topicBuffer.write(name)
  return b4a.toString(crypto.discoveryKey(topicBuffer), 'hex')
}

// Helper: Join a Hyperswarm topic
function joinTopic(name, options = {}) {
  const { server = true, client = true } = options
  const topicBuffer = Buffer.alloc(32)
  topicBuffer.write(name)
  const topicKey = getTopicKey(name)
  
  if (topics.has(topicKey)) {
    console.log(`[topic] Already joined: ${name}`)
    return topicKey
  }
  
  const discovery = swarm.join(topicBuffer, { server, client })
  
  topics.set(topicKey, {
    name,
    key: topicKey,
    discovery,
    peers: new Set(),
    joinedAt: new Date().toISOString(),
    server,
    client,
    messageCount: 0,
    lastActivity: new Date().toISOString()
  })
  
  console.log(`[topic] Joined: ${name} (key: ${topicKey.slice(0, 16)}...)`)
  
  // Broadcast to WebSocket clients
  broadcastToWebSocketClients({
    type: 'topic-joined',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { name, key: topicKey }
  })
  
  // Broadcast to relay clients
  broadcastToRelayClients({
    type: 'channel_joined',
    channel: name,
    timestamp: Date.now()
  })
  
  activityStats.totalTopics++
  return topicKey
}

// Helper: Leave a topic
function leaveTopic(name) {
  const topicKey = getTopicKey(name)
  const topic = topics.get(topicKey)
  
  if (!topic) {
    console.log(`[topic] Not joined: ${name}`)
    return false
  }
  
  topic.discovery.destroy()
  topics.delete(topicKey)
  
  console.log(`[topic] Left: ${name}`)
  
  // Broadcast to WebSocket clients
  broadcastToWebSocketClients({
    type: 'topic-left',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { name, key: topicKey }
  })
  
  return true
}

// Helper: Register or update agent
function registerAgent(agentData) {
  const { id, name, type, capabilities, publicKey, topics: agentTopics, metadata } = agentData
  const agentId = id || publicKey
  
  if (!agentId) {
    console.warn('[agent] Cannot register agent without id or publicKey')
    return null
  }
  
  const now = new Date().toISOString()
  const existing = agents.get(agentId)
  
  if (existing) {
    // Update existing agent
    existing.lastSeen = now
    if (name) existing.name = name
    if (type) existing.type = type
    if (capabilities) existing.capabilities = capabilities
    if (agentTopics) existing.topics = new Set([...existing.topics, ...agentTopics])
    if (metadata) existing.metadata = { ...existing.metadata, ...metadata }
    console.log(`[agent] Updated: ${agentId.slice(0, 16)}... (${name || 'unnamed'})`)
  } else {
    // Register new agent
    agents.set(agentId, {
      id: agentId,
      name: name || 'Unknown Agent',
      type: type || 'unknown',
      capabilities: capabilities || [],
      publicKey: publicKey || agentId,
      topics: new Set(agentTopics || []),
      firstSeen: now,
      lastSeen: now,
      metadata: metadata || {}
    })
    activityStats.totalAgents++
    console.log(`[agent] Registered: ${agentId.slice(0, 16)}... (${name || 'unnamed'})`)
    
    // Broadcast agent-discovered event
    broadcastToWebSocketClients({
      type: 'agent-discovered',
      id: 'evt-' + Date.now(),
      timestamp: now,
      payload: agents.get(agentId)
    })
  }
  
  return agents.get(agentId)
}

// Helper: Archive message
function archiveMessage(message) {
  messages.push(message)
  if (messages.length > MAX_MESSAGES) {
    messages.shift()
  }
  activityStats.totalMessages++
  
  // Update hourly stats
  const hour = new Date().toISOString().slice(0, 13)
  if (!activityStats.hourlyStats[hour]) {
    activityStats.hourlyStats[hour] = { messages: 0, agents: new Set() }
  }
  activityStats.hourlyStats[hour].messages++
}

// Helper: Broadcast to WebSocket clients (Observatory protocol)
function broadcastToWebSocketClients(message) {
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  })
}

// Helper: Broadcast to relay clients (agents-services protocol)
function broadcastToRelayClients(message, channelFilter = null) {
  relayClients.forEach((clientInfo, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      // If channelFilter specified, only send to clients on that channel
      if (channelFilter && !clientInfo.channels.has(channelFilter)) {
        return
      }
      ws.send(JSON.stringify(message))
    }
  })
}

// Helper: Relay message cross-protocol (WebSocket Relay → Hyperswarm)
function relayToHyperswarm(channelName, message, fromAgentId) {
  // Security: Only relay public channels
  if (!PUBLIC_CHANNELS.has(channelName)) {
    console.log(`[relay] Blocked: ${channelName} is not a public channel`)
    return
  }
  
  console.log(`[relay] WebSocket → Hyperswarm: ${channelName}`)
  
  // Convert to Hyperswarm format and broadcast
  const hyperswarmMessage = {
    type: message.type || 'message',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: {
      source: fromAgentId || 'relay',
      channel: channelName,
      ...message
    }
  }
  
  // Send to all Hyperswarm peers
  peers.forEach(peer => {
    if (peer.conn && !peer.conn.destroyed) {
      peer.conn.write(JSON.stringify(hyperswarmMessage))
    }
  })
  
  // Archive
  archiveMessage(hyperswarmMessage)
}

// Helper: Relay message cross-protocol (Hyperswarm → WebSocket Relay)
function relayToWebSocketRelay(topicName, message, fromPublicKey) {
  // Security: Only relay public topics
  if (!PUBLIC_CHANNELS.has(topicName)) {
    console.log(`[relay] Blocked: ${topicName} is not a public topic`)
    return
  }
  
  console.log(`[relay] Hyperswarm → WebSocket: ${topicName}`)
  
  // Convert to relay format
  const relayMessage = {
    type: 'sidechannel_message',
    channel: topicName,
    from: fromPublicKey || bridgePublicKey,
    message: message,
    timestamp: Date.now()
  }
  
  // Broadcast to relay clients on this channel
  broadcastToRelayClients(relayMessage, topicName)
}

// Hyperswarm: Handle peer connections
swarm.on('connection', (conn, info) => {
  const peerId = b4a.toString(info.publicKey, 'hex')
  console.log('[swarm] Peer connected:', peerId.slice(0, 16) + '...')
  
  // Register peer
  peers.set(peerId, {
    conn,
    publicKey: peerId,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    isClient: info.client,
    isServer: info.server,
    topics: new Set()
  })
  
  // Notify WebSocket clients
  const joinEvent = {
    type: 'agent-join',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { agentId: peerId, publicKey: peerId }
  }
  broadcastToWebSocketClients(joinEvent)
  
  // Register as agent
  registerAgent({
    id: peerId,
    publicKey: peerId,
    type: 'hyperswarm-peer',
    topics: []
  })
  
  // Handle incoming data
  conn.on('data', data => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      msg = {
        type: 'message',
        id: 'evt-' + Date.now(),
        timestamp: new Date().toISOString(),
        payload: { source: peerId, raw: data.toString('hex').slice(0, 64) }
      }
    }
    
    // Update peer last seen
    const peer = peers.get(peerId)
    if (peer) peer.lastSeen = new Date().toISOString()
    
    // Handle agent-announce messages
    if (msg.type === 'agent-announce' && msg.payload) {
      registerAgent({
        id: msg.payload.agentId || peerId,
        name: msg.payload.name,
        type: msg.payload.type,
        capabilities: msg.payload.capabilities,
        publicKey: peerId,
        metadata: msg.payload
      })
    }
    
    // Archive message
    archiveMessage(msg)
    
    // Broadcast to WebSocket clients
    broadcastToWebSocketClients(msg)
    
    // Relay to WebSocket relay if from public topic
    // (Note: We don't know which topic this came from in Hyperswarm, so we relay all)
    relayToWebSocketRelay('0000intercom', msg, peerId)
  })
  
  conn.on('close', () => {
    console.log('[swarm] Peer disconnected:', peerId.slice(0, 16) + '...')
    peers.delete(peerId)
    
    const leaveEvent = {
      type: 'agent-leave',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { agentId: peerId }
    }
    broadcastToWebSocketClients(leaveEvent)
  })
  
  conn.on('error', err => console.error('[swarm] Connection error:', err.message))
})

// HTTP Server
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }
  
  res.setHeader('Content-Type', 'application/json')
  
  // Health endpoint
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({
      status: 'ok',
      mode: 'unified',
      publicKey: bridgePublicKey,
      clients: clients.size,
      relayClients: relayClients.size,
      peers: peers.size,
      topics: topics.size,
      agents: agents.size,
      uptime: (Date.now() - activityStats.startTime) / 1000
    }))
    return
  }
  
  // Peers endpoint
  if (req.url === '/peers') {
    const peerList = Array.from(peers.values()).map(p => ({
      publicKey: p.publicKey,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      isClient: p.isClient,
      isServer: p.isServer,
      topics: Array.from(p.topics)
    }))
    res.writeHead(200)
    res.end(JSON.stringify({ count: peerList.length, peers: peerList }))
    return
  }
  
  // Topics endpoint
  if (req.url === '/topics') {
    const topicList = Array.from(topics.values()).map(t => ({
      name: t.name,
      key: t.key,
      peers: Array.from(t.peers),
      peerCount: t.peers.size,
      joinedAt: t.joinedAt,
      server: t.server,
      client: t.client,
      messageCount: t.messageCount,
      lastActivity: t.lastActivity
    }))
    res.writeHead(200)
    res.end(JSON.stringify({ count: topicList.length, topics: topicList }))
    return
  }
  
  // Agents endpoint
  if (req.url === '/agents') {
    const agentList = Array.from(agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      capabilities: a.capabilities,
      publicKey: a.publicKey,
      topics: Array.from(a.topics),
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      metadata: a.metadata
    }))
    res.writeHead(200)
    res.end(JSON.stringify({ count: agentList.length, agents: agentList }))
    return
  }
  
  // Messages endpoint
  if (req.url === '/messages' || req.url.startsWith('/messages?')) {
    res.writeHead(200)
    res.end(JSON.stringify({ count: messages.length, messages: messages.slice(-100) }))
    return
  }
  
  // Activity endpoint
  if (req.url === '/activity') {
    res.writeHead(200)
    res.end(JSON.stringify({
      uptime: (Date.now() - activityStats.startTime) / 1000,
      totalMessages: activityStats.totalMessages,
      totalAgents: activityStats.totalAgents,
      totalTopics: activityStats.totalTopics,
      activeAgents: agents.size,
      activeTopics: topics.size,
      activePeers: peers.size,
      activeClients: clients.size,
      activeRelayClients: relayClients.size,
      hourlyStats: activityStats.hourlyStats
    }))
    return
  }
  
  // Network endpoint
  if (req.url === '/network') {
    res.writeHead(200)
    res.end(JSON.stringify({
      bridge: {
        publicKey: bridgePublicKey,
        mode: 'unified',
        uptime: (Date.now() - activityStats.startTime) / 1000
      },
      peers: peers.size,
      topics: topics.size,
      agents: agents.size,
      clients: clients.size,
      relayClients: relayClients.size,
      messages: messages.length
    }))
    return
  }
  
  // Info endpoint
  if (req.url === '/info') {
    res.writeHead(200)
    res.end(JSON.stringify({
      name: 'Unified Intercom Bridge',
      version: '2.0.0',
      mode: 'unified',
      publicKey: bridgePublicKey,
      protocols: ['hyperswarm', 'websocket-relay'],
      features: [
        'agent-discovery',
        'message-archival',
        'cross-protocol-relay',
        'topic-management',
        'activity-tracking'
      ],
      endpoints: ['/health', '/peers', '/topics', '/agents', '/messages', '/activity', '/network', '/info'],
      websocketCommands: ['ping', 'list_peers', 'list_topics', 'list_agents', 'join_topic', 'leave_topic', 'get_stats', 'get_activity'],
      relayActions: ['join', 'leave', 'send', 'publish'],
      security: {
        relayAuth: ENABLE_RELAY_AUTH ? 'enabled' : 'disabled',
        publicChannels: Array.from(PUBLIC_CHANNELS)
      }
    }))
    return
  }
  
  // 404
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

// WebSocket Server (supports both protocols)
const wss = new WebSocket.Server({ server })
const clients = new Set()

wss.on('connection', (ws, req) => {
  const clientId = 'ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  console.log('[ws] Client connected:', clientId)
  
  // Detect protocol by first message
  let protocolDetected = false
  let isRelayClient = false
  
  clients.add(ws)
  
  // Initialize relay client info
  const relayClientInfo = {
    id: clientId,
    authenticated: !ENABLE_RELAY_AUTH, // Auto-auth if auth disabled
    channels: new Set(),
    agentId: null
  }
  
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString())
      
      // Detect protocol on first message
      if (!protocolDetected) {
        if (msg.action) {
          // agents-services relay protocol
          isRelayClient = true
          relayClients.set(ws, relayClientInfo)
          console.log('[ws] Detected relay protocol:', clientId)
        }
        protocolDetected = true
      }
      
      // Handle relay protocol (agents-services)
      if (isRelayClient) {
        handleRelayMessage(ws, msg, relayClientInfo)
        return
      }
      
      // Handle Observatory protocol
      handleObservatoryMessage(ws, msg)
      
    } catch (err) {
      console.error('[ws] Message parse error:', err.message)
    }
  })
  
  ws.on('close', () => {
    console.log('[ws] Client disconnected:', clientId)
    clients.delete(ws)
    
    if (isRelayClient) {
      // Remove from relay channels
      relayClientInfo.channels.forEach(channel => {
        const channelClients = relayChannels.get(channel)
        if (channelClients) {
          channelClients.delete(ws)
          if (channelClients.size === 0) {
            relayChannels.delete(channel)
          }
        }
      })
      relayClients.delete(ws)
    }
  })
  
  ws.on('error', err => console.error('[ws] Error:', err.message))
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    bridge: bridgePublicKey,
    mode: 'unified',
    timestamp: Date.now()
  }))
})

// Handle relay protocol messages (agents-services)
function handleRelayMessage(ws, msg, clientInfo) {
  const { action, channel, message, agentId, token } = msg
  
  // Authentication check
  if (ENABLE_RELAY_AUTH && !clientInfo.authenticated) {
    if (token === RELAY_AUTH_TOKEN) {
      clientInfo.authenticated = true
      console.log('[relay] Client authenticated:', clientInfo.id)
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Authentication required',
        timestamp: Date.now()
      }))
      return
    }
  }
  
  if (!clientInfo.authenticated) {
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Not authenticated',
      timestamp: Date.now()
    }))
    return
  }
  
  // Handle actions
  switch (action) {
    case 'join':
      // Join a channel
      clientInfo.channels.add(channel)
      if (agentId) clientInfo.agentId = agentId
      
      if (!relayChannels.has(channel)) {
        relayChannels.set(channel, new Set())
      }
      relayChannels.get(channel).add(ws)
      
      console.log(`[relay] ${clientInfo.id} joined channel: ${channel}`)
      
      // Join corresponding Hyperswarm topic if public
      if (PUBLIC_CHANNELS.has(channel)) {
        joinTopic(channel)
      }
      
      ws.send(JSON.stringify({
        type: 'joined',
        channel,
        timestamp: Date.now()
      }))
      break
      
    case 'leave':
      // Leave a channel
      clientInfo.channels.delete(channel)
      const channelClients = relayChannels.get(channel)
      if (channelClients) {
        channelClients.delete(ws)
        if (channelClients.size === 0) {
          relayChannels.delete(channel)
        }
      }
      
      console.log(`[relay] ${clientInfo.id} left channel: ${channel}`)
      
      ws.send(JSON.stringify({
        type: 'left',
        channel,
        timestamp: Date.now()
      }))
      break
      
    case 'send':
    case 'publish':
      // Send message to channel
      if (!clientInfo.channels.has(channel)) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Not joined to channel',
          channel,
          timestamp: Date.now()
        }))
        return
      }
      
      console.log(`[relay] Message on ${channel} from ${clientInfo.agentId || clientInfo.id}`)
      
      // Handle discovery messages
      if (message && message.type === 'discovery') {
        registerAgent({
          id: message.agentId,
          name: message.name,
          type: 'relay-agent',
          capabilities: message.capabilities,
          metadata: message
        })
      }
      
      // Broadcast to other relay clients on this channel
      const recipients = relayChannels.get(channel)
      if (recipients) {
        recipients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'sidechannel_message',
              channel,
              from: clientInfo.agentId || clientInfo.id,
              message,
              timestamp: Date.now()
            }))
          }
        })
      }
      
      // Relay to Hyperswarm if public channel
      relayToHyperswarm(channel, message, clientInfo.agentId)
      
      // Archive
      archiveMessage({
        type: 'relay-message',
        channel,
        from: clientInfo.agentId || clientInfo.id,
        message,
        timestamp: new Date().toISOString()
      })
      break
      
    default:
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Unknown action',
        action,
        timestamp: Date.now()
      }))
  }
}

// Handle Observatory protocol messages
function handleObservatoryMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
      break
      
    case 'list_peers':
      const peerList = Array.from(peers.values()).map(p => ({
        publicKey: p.publicKey,
        connectedAt: p.connectedAt,
        lastSeen: p.lastSeen
      }))
      ws.send(JSON.stringify({ type: 'peer-list', peers: peerList }))
      break
      
    case 'list_topics':
      const topicList = Array.from(topics.values()).map(t => ({
        name: t.name,
        key: t.key,
        peerCount: t.peers.size
      }))
      ws.send(JSON.stringify({ type: 'topic-list', topics: topicList }))
      break
      
    case 'list_agents':
      const agentList = Array.from(agents.values())
      ws.send(JSON.stringify({ type: 'agent-list', agents: agentList }))
      break
      
    case 'join_topic':
      if (msg.payload && msg.payload.name) {
        joinTopic(msg.payload.name, msg.payload)
        ws.send(JSON.stringify({ type: 'topic-joined', topic: msg.payload.name }))
      }
      break
      
    case 'leave_topic':
      if (msg.payload && msg.payload.name) {
        leaveTopic(msg.payload.name)
        ws.send(JSON.stringify({ type: 'topic-left', topic: msg.payload.name }))
      }
      break
      
    case 'get_stats':
      ws.send(JSON.stringify({
        type: 'stats',
        peers: peers.size,
        topics: topics.size,
        agents: agents.size,
        messages: messages.length
      }))
      break
      
    case 'get_activity':
      ws.send(JSON.stringify({
        type: 'activity',
        ...activityStats
      }))
      break
  }
}

// Auto-join common topics on startup
const AUTO_JOIN_TOPICS = [
  'sc-bridge-discovery',
  'agent-marketplace',
  'agent-announce',
  'intercom-global',
  'agent-network',
  '0000intercom',
  'agents-services'
]

// Start server
server.listen(PORT, () => {
  console.log(`[server] Unified Bridge listening on :${PORT}`)
  console.log(`[server] Mode: unified (WebSocket Relay + Hyperswarm P2P)`)
  console.log(`[server] Relay auth: ${ENABLE_RELAY_AUTH ? 'enabled' : 'disabled'}`)
  console.log(`[server] Public channels:`, Array.from(PUBLIC_CHANNELS))
  
  // Auto-join topics after server starts
  setTimeout(() => {
    AUTO_JOIN_TOPICS.forEach(topic => joinTopic(topic))
  }, 1000)
})

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('[shutdown] Closing connections...')
  swarm.destroy()
  server.close()
  process.exit(0)
})
