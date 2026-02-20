const Hyperswarm = require('hyperswarm')
const { WebSocketServer } = require('ws')
const crypto = require('hypercore-crypto')
const http = require('http')
const fs = require('fs')

// Persist keypair across restarts (volume mount at /data)
const KEYFILE = '/data/swarm.key'
let keyPair

if (fs.existsSync(KEYFILE)) {
  const seed = fs.readFileSync(KEYFILE)
  keyPair = crypto.keyPair(seed)
} else {
  const seed = crypto.randomBytes(32)
  fs.mkdirSync('/data', { recursive: true })
  fs.writeFileSync(KEYFILE, seed)
  keyPair = crypto.keyPair(seed)
}

const swarm = new Hyperswarm({ keyPair })
const startTime = Date.now()

// ===== NETWORK OBSERVATORY STORAGE =====

// Track connected peers with metadata
const peers = new Map() // peerId -> { publicKey, conn, connectedAt, lastSeen, metadata, topics }

// Agent Registry - discovered agents with full metadata
const agents = new Map() // agentId -> { id, name, type, capabilities, publicKey, topics, firstSeen, lastSeen, metadata }

// Message Archive - recent messages across all topics (configurable limit)
const MESSAGE_LIMIT = 1000
const messages = [] // Array of { id, timestamp, topic, sender, content, metadata }

// Activity Tracker
const activity = {
  messagesReceived: 0,
  messagesSent: 0,
  agentsDiscovered: 0,
  topicsDiscovered: 0,
  startTime: Date.now(),
  hourlyStats: new Map() // hour -> { messages, agents, topics }
}

// Track topics/channels
const topics = new Map() // topicKey -> { name, key, discovery, peers: Set(), joinedAt, messageCount, lastActivity }
const topicDiscoveries = new Map() // topicKey -> discovery object from swarm

// Common agent topics to auto-join
const AUTO_JOIN_TOPICS = [
  'sc-bridge-discovery',
  'agent-marketplace',
  'agent-announce',
  'intercom-global',
  'agent-network'
]

// Helper: Create topic key from name
function getTopicKey(topicName) {
  const topicHash = require('crypto').createHash('sha256').update(topicName).digest()
  return crypto.discoveryKey(topicHash)
}

// Helper: Join a topic
function joinTopic(topicName, options = {}) {
  const topicKey = getTopicKey(topicName)
  const topicKeyHex = topicKey.toString('hex')
  
  if (topics.has(topicKeyHex)) {
    console.log(`[topic] already joined: ${topicName}`)
    return topicKeyHex
  }
  
  const discovery = swarm.join(topicKey, { 
    server: options.server !== false,
    client: options.client !== false
  })
  
  topics.set(topicKeyHex, {
    name: topicName,
    key: topicKeyHex,
    discovery: discovery,
    peers: new Set(),
    joinedAt: new Date().toISOString(),
    server: options.server !== false,
    client: options.client !== false,
    messageCount: 0,
    lastActivity: new Date().toISOString()
  })
  
  topicDiscoveries.set(topicKeyHex, discovery)
  
  console.log(`[topic] joined: ${topicName} (${topicKeyHex.slice(0, 16)}...)`)
  
  // Track topic discovery
  activity.topicsDiscovered++
  
  // Notify WebSocket clients
  const joinEvent = JSON.stringify({
    type: 'topic-joined',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: {
      name: topicName,
      key: topicKeyHex
    }
  })
  
  if (typeof clients !== 'undefined') {
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(joinEvent)
    })
  }
  
  return topicKeyHex
}

// Helper: Leave a topic
function leaveTopic(topicName) {
  const topicKey = getTopicKey(topicName)
  const topicKeyHex = topicKey.toString('hex')
  
  const topic = topics.get(topicKeyHex)
  if (!topic) {
    return false
  }
  
  const discovery = topicDiscoveries.get(topicKeyHex)
  if (discovery) {
    discovery.destroy()
    topicDiscoveries.delete(topicKeyHex)
  }
  
  topics.delete(topicKeyHex)
  
  console.log(`[topic] left: ${topicName}`)
  
  const leaveEvent = JSON.stringify({
    type: 'topic-left',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: {
      name: topicName,
      key: topicKeyHex
    }
  })
  
  if (typeof clients !== 'undefined') {
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(leaveEvent)
    })
  }
  
  return true
}

// Helper: Register or update agent in registry
function registerAgent(agentData) {
  const agentId = agentData.publicKey || agentData.id || agentData.agentId
  
  if (!agentId) {
    console.warn('[agent-registry] Cannot register agent without ID')
    return
  }
  
  const now = new Date().toISOString()
  
  if (agents.has(agentId)) {
    // Update existing agent
    const agent = agents.get(agentId)
    agent.lastSeen = now
    agent.metadata = { ...agent.metadata, ...agentData.metadata }
    if (agentData.topics) {
      agent.topics = Array.isArray(agentData.topics) ? agentData.topics : Array.from(agentData.topics)
    }
    console.log(`[agent-registry] updated: ${agentData.name || agentId.slice(0, 16)}`)
  } else {
    // Register new agent
    agents.set(agentId, {
      id: agentId,
      name: agentData.name || `Agent-${agentId.slice(0, 8)}`,
      type: agentData.type || 'unknown',
      capabilities: agentData.capabilities || [],
      publicKey: agentId,
      topics: agentData.topics || [],
      firstSeen: now,
      lastSeen: now,
      metadata: agentData.metadata || {}
    })
    
    activity.agentsDiscovered++
    console.log(`[agent-registry] discovered: ${agentData.name || agentId.slice(0, 16)}`)
    
    // Notify WebSocket clients
    const announceEvent = JSON.stringify({
      type: 'agent-discovered',
      id: 'evt-' + Date.now(),
      timestamp: now,
      payload: agents.get(agentId)
    })
    
    if (typeof clients !== 'undefined') {
      clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(announceEvent)
      })
    }
  }
}

// Helper: Archive message
function archiveMessage(messageData) {
  const messageId = messageData.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  
  const message = {
    id: messageId,
    timestamp: messageData.timestamp || new Date().toISOString(),
    topic: messageData.topic || 'unknown',
    sender: messageData.sender || messageData.source || 'unknown',
    content: messageData.content || messageData.payload || messageData,
    metadata: messageData.metadata || {},
    type: messageData.type || 'message'
  }
  
  messages.push(message)
  
  // Enforce message limit
  if (messages.length > MESSAGE_LIMIT) {
    messages.shift() // Remove oldest message
  }
  
  activity.messagesReceived++
  
  // Update topic activity
  const topicKey = message.topic
  if (topics.has(topicKey)) {
    const topic = topics.get(topicKey)
    topic.messageCount++
    topic.lastActivity = message.timestamp
  }
  
  // Update hourly stats
  const hour = new Date().toISOString().slice(0, 13) // YYYY-MM-DDTHH
  if (!activity.hourlyStats.has(hour)) {
    activity.hourlyStats.set(hour, { messages: 0, agents: new Set(), topics: new Set() })
  }
  const hourStats = activity.hourlyStats.get(hour)
  hourStats.messages++
  hourStats.agents.add(message.sender)
  hourStats.topics.add(message.topic)
  
  console.log(`[message-archive] stored: ${messageId.slice(0, 16)} from ${message.sender.slice(0, 8)}`)
}

// Create HTTP server with multiple endpoints
const server = http.createServer((req, res) => {
  // Add CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST')
  res.setHeader('Content-Type', 'application/json')
  
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({
      status: 'ok',
      publicKey: keyPair.publicKey.toString('hex').slice(0, 16) + '...',
      clients: clients.size,
      uptime: process.uptime(),
      mode: 'observatory'
    }))
  } 
  else if (req.url === '/peers') {
    const peerList = Array.from(peers.values()).map(p => ({
      id: p.publicKey,
      publicKey: p.publicKey,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      uptime: Date.now() - new Date(p.connectedAt).getTime(),
      metadata: p.metadata || {},
      topics: Array.from(p.topics || [])
    }))
    res.writeHead(200)
    res.end(JSON.stringify({
      count: peerList.length,
      peers: peerList
    }))
  }
  else if (req.url === '/agents') {
    // NEW: Agent registry endpoint
    const agentList = Array.from(agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      capabilities: a.capabilities,
      publicKey: a.publicKey,
      topics: a.topics,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      uptime: Date.now() - new Date(a.firstSeen).getTime(),
      metadata: a.metadata
    }))
    res.writeHead(200)
    res.end(JSON.stringify({
      count: agentList.length,
      agents: agentList
    }))
  }
  else if (req.url.startsWith('/agents/')) {
    // NEW: Get specific agent details
    const agentId = req.url.split('/agents/')[1]
    const agent = agents.get(agentId)
    
    if (!agent) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Agent not found' }))
      return
    }
    
    res.writeHead(200)
    res.end(JSON.stringify(agent))
  }
  else if (req.url.startsWith('/messages')) {
    // NEW: Message archive endpoint with filters
    const url = new URL(req.url, `http://${req.headers.host}`)
    const topic = url.searchParams.get('topic')
    const sender = url.searchParams.get('sender')
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const offset = parseInt(url.searchParams.get('offset') || '0')
    
    let filtered = messages
    
    if (topic) {
      filtered = filtered.filter(m => m.topic === topic)
    }
    
    if (sender) {
      filtered = filtered.filter(m => m.sender === sender)
    }
    
    const paginated = filtered.slice(offset, offset + limit)
    
    res.writeHead(200)
    res.end(JSON.stringify({
      total: filtered.length,
      offset: offset,
      limit: limit,
      messages: paginated
    }))
  }
  else if (req.url === '/activity') {
    // NEW: Network activity metrics
    const uptime = Date.now() - activity.startTime
    const messagesPerSecond = activity.messagesReceived / (uptime / 1000)
    
    res.writeHead(200)
    res.end(JSON.stringify({
      uptime: uptime,
      messagesReceived: activity.messagesReceived,
      messagesSent: activity.messagesSent,
      messagesPerSecond: messagesPerSecond.toFixed(2),
      agentsDiscovered: activity.agentsDiscovered,
      topicsDiscovered: activity.topicsDiscovered,
      currentAgents: agents.size,
      currentTopics: topics.size,
      currentPeers: peers.size,
      currentClients: clients.size,
      archivedMessages: messages.length
    }))
  }
  else if (req.url === '/graph') {
    // NEW: Network graph data (nodes + edges)
    const nodes = []
    const edges = []
    
    // Add bridge as central node
    nodes.push({
      id: 'bridge',
      type: 'bridge',
      label: 'SC-Bridge',
      publicKey: keyPair.publicKey.toString('hex')
    })
    
    // Add agents as nodes
    agents.forEach(agent => {
      nodes.push({
        id: agent.id,
        type: 'agent',
        label: agent.name,
        agentType: agent.type,
        capabilities: agent.capabilities,
        publicKey: agent.publicKey
      })
      
      // Add edge from agent to bridge
      edges.push({
        source: agent.id,
        target: 'bridge',
        type: 'connection'
      })
      
      // Add edges from agent to topics
      agent.topics.forEach(topicKey => {
        edges.push({
          source: agent.id,
          target: topicKey,
          type: 'subscription'
        })
      })
    })
    
    // Add topics as nodes
    topics.forEach(topic => {
      nodes.push({
        id: topic.key,
        type: 'topic',
        label: topic.name,
        peerCount: topic.peers.size,
        messageCount: topic.messageCount
      })
      
      // Add edge from topic to bridge
      edges.push({
        source: topic.key,
        target: 'bridge',
        type: 'hosted'
      })
    })
    
    res.writeHead(200)
    res.end(JSON.stringify({
      nodes: nodes,
      edges: edges
    }))
  }
  else if (req.url === '/clients') {
    const clientList = Array.from(clients).map((ws, idx) => ({
      id: `client-${idx}`,
      connectedAt: ws.connectedAt || new Date().toISOString(),
      readyState: ws.readyState
    }))
    res.writeHead(200)
    res.end(JSON.stringify({
      count: clientList.length,
      clients: clientList
    }))
  }
  else if (req.url === '/topics') {
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
    res.end(JSON.stringify({
      count: topicList.length,
      topics: topicList
    }))
  }
  else if (req.url.startsWith('/topics/')) {
    const topicKey = req.url.split('/topics/')[1]
    const topic = topics.get(topicKey)
    
    if (!topic) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Topic not found' }))
      return
    }
    
    const peerDetails = Array.from(topic.peers).map(peerId => {
      const peer = peers.get(peerId)
      return peer ? {
        id: peerId,
        publicKey: peerId,
        connectedAt: peer.connectedAt,
        lastSeen: peer.lastSeen
      } : { id: peerId, publicKey: peerId }
    })
    
    res.writeHead(200)
    res.end(JSON.stringify({
      name: topic.name,
      key: topic.key,
      peerCount: topic.peers.size,
      peers: peerDetails,
      joinedAt: topic.joinedAt,
      server: topic.server,
      client: topic.client,
      messageCount: topic.messageCount,
      lastActivity: topic.lastActivity
    }))
  }
  else if (req.url === '/network') {
    res.writeHead(200)
    res.end(JSON.stringify({
      bridge: {
        publicKey: keyPair.publicKey.toString('hex'),
        uptime: Date.now() - startTime,
        startedAt: new Date(startTime).toISOString(),
        mode: 'observatory'
      },
      peers: {
        count: peers.size,
        list: Array.from(peers.keys())
      },
      agents: {
        count: agents.size,
        list: Array.from(agents.keys())
      },
      clients: {
        count: clients.size
      },
      topics: {
        count: topics.size,
        list: Array.from(topics.values()).map(t => ({
          name: t.name,
          key: t.key,
          peerCount: t.peers.size,
          messageCount: t.messageCount
        }))
      },
      messages: {
        archived: messages.length,
        total: activity.messagesReceived
      }
    }))
  }
  else if (req.url === '/stats') {
    res.writeHead(200)
    res.end(JSON.stringify({
      bridge: {
        publicKey: keyPair.publicKey.toString('hex'),
        uptime: process.uptime(),
        startedAt: new Date(startTime).toISOString(),
        mode: 'observatory'
      },
      connections: {
        peers: peers.size,
        agents: agents.size,
        clients: clients.size,
        topics: topics.size,
        total: peers.size + clients.size
      },
      activity: {
        messagesReceived: activity.messagesReceived,
        messagesSent: activity.messagesSent,
        agentsDiscovered: activity.agentsDiscovered,
        topicsDiscovered: activity.topicsDiscovered
      },
      peers: Array.from(peers.values()).map(p => ({
        id: p.publicKey.slice(0, 16) + '...',
        uptime: Date.now() - new Date(p.connectedAt).getTime(),
        topics: Array.from(p.topics || []).length
      }))
    }))
  }
  else if (req.url === '/info') {
    res.writeHead(200)
    res.end(JSON.stringify({
      name: 'sc-bridge-observatory',
      version: '3.0.0',
      mode: 'observatory',
      publicKey: keyPair.publicKey.toString('hex'),
      capabilities: [
        'websocket',
        'hyperswarm',
        'peer-discovery',
        'message-relay',
        'topic-management',
        'agent-registry',
        'message-archival',
        'network-observatory'
      ],
      endpoints: [
        '/',
        '/health',
        '/peers',
        '/agents',
        '/agents/:publicKey',
        '/messages',
        '/activity',
        '/graph',
        '/clients',
        '/topics',
        '/topics/:key',
        '/network',
        '/stats',
        '/info'
      ],
      websocketCommands: [
        'ping',
        'list_peers',
        'list_agents',
        'list_messages',
        'get_stats',
        'get_info',
        'list_topics',
        'join_topic',
        'leave_topic',
        'get_activity',
        'get_graph'
      ]
    }))
  }
  else {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not Found' }))
  }
})

// Attach WebSocket server to HTTP server
const wss = new WebSocketServer({ server })
const clients = new Set()

// Auto-join common agent topics
console.log('[observatory] Auto-joining common agent topics...')
AUTO_JOIN_TOPICS.forEach(topicName => {
  joinTopic(topicName, { server: true, client: true })
})

wss.on('connection', ws => {
  ws.connectedAt = new Date().toISOString()
  clients.add(ws)
  console.log(`[ws] client connected — ${clients.size} total`)
  
  // Send current peer list to new client
  const peerList = Array.from(peers.values()).map(p => ({
    type: 'agent-join',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { 
      agentId: p.publicKey, 
      publicKey: p.publicKey,
      connectedAt: p.connectedAt,
      metadata: p.metadata || {},
      topics: Array.from(p.topics || [])
    }
  }))
  
  if (peerList.length > 0) {
    ws.send(JSON.stringify({
      type: 'peer-list',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { peers: peerList }
    }))
  }
  
  // Send current agent registry
  const agentList = Array.from(agents.values())
  if (agentList.length > 0) {
    ws.send(JSON.stringify({
      type: 'agent-list',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { agents: agentList }
    }))
  }
  
  // Send current topic list
  const topicList = Array.from(topics.values()).map(t => ({
    name: t.name,
    key: t.key,
    peerCount: t.peers.size,
    joinedAt: t.joinedAt,
    messageCount: t.messageCount
  }))
  
  if (topicList.length > 0) {
    ws.send(JSON.stringify({
      type: 'topic-list',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { topics: topicList }
    }))
  }
  
  ws.on('message', msg => {
    try {
      const d = JSON.parse(msg)
      
      if (d.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
      }
      else if (d.type === 'list_peers') {
        const peerData = Array.from(peers.values()).map(p => ({
          id: p.publicKey,
          publicKey: p.publicKey,
          connectedAt: p.connectedAt,
          lastSeen: p.lastSeen,
          metadata: p.metadata || {},
          topics: Array.from(p.topics || [])
        }))
        ws.send(JSON.stringify({
          type: 'peer-list',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { peers: peerData }
        }))
      }
      else if (d.type === 'list_agents') {
        // NEW: List all discovered agents
        const agentData = Array.from(agents.values())
        ws.send(JSON.stringify({
          type: 'agent-list',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { agents: agentData }
        }))
      }
      else if (d.type === 'list_messages') {
        // NEW: List recent messages
        const limit = d.payload?.limit || 100
        const recentMessages = messages.slice(-limit)
        ws.send(JSON.stringify({
          type: 'message-list',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { messages: recentMessages }
        }))
      }
      else if (d.type === 'get_activity') {
        // NEW: Get activity metrics
        const uptime = Date.now() - activity.startTime
        const messagesPerSecond = activity.messagesReceived / (uptime / 1000)
        
        ws.send(JSON.stringify({
          type: 'activity',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: {
            uptime: uptime,
            messagesReceived: activity.messagesReceived,
            messagesSent: activity.messagesSent,
            messagesPerSecond: messagesPerSecond.toFixed(2),
            agentsDiscovered: activity.agentsDiscovered,
            topicsDiscovered: activity.topicsDiscovered,
            currentAgents: agents.size,
            currentTopics: topics.size
          }
        }))
      }
      else if (d.type === 'get_graph') {
        // NEW: Get network graph
        const nodes = []
        const edges = []
        
        nodes.push({
          id: 'bridge',
          type: 'bridge',
          label: 'SC-Bridge'
        })
        
        agents.forEach(agent => {
          nodes.push({
            id: agent.id,
            type: 'agent',
            label: agent.name
          })
          edges.push({ source: agent.id, target: 'bridge' })
        })
        
        topics.forEach(topic => {
          nodes.push({
            id: topic.key,
            type: 'topic',
            label: topic.name
          })
          edges.push({ source: topic.key, target: 'bridge' })
        })
        
        ws.send(JSON.stringify({
          type: 'graph',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { nodes, edges }
        }))
      }
      else if (d.type === 'list_topics') {
        const topicData = Array.from(topics.values()).map(t => ({
          name: t.name,
          key: t.key,
          peerCount: t.peers.size,
          peers: Array.from(t.peers),
          joinedAt: t.joinedAt,
          messageCount: t.messageCount
        }))
        ws.send(JSON.stringify({
          type: 'topic-list',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { topics: topicData }
        }))
      }
      else if (d.type === 'join_topic') {
        if (!d.payload || !d.payload.name) {
          ws.send(JSON.stringify({
            type: 'error',
            id: 'evt-' + Date.now(),
            timestamp: new Date().toISOString(),
            payload: { message: 'Topic name required' }
          }))
          return
        }
        
        const topicKey = joinTopic(d.payload.name, d.payload.options || {})
        ws.send(JSON.stringify({
          type: 'topic-joined',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { name: d.payload.name, key: topicKey }
        }))
      }
      else if (d.type === 'leave_topic') {
        if (!d.payload || !d.payload.name) {
          ws.send(JSON.stringify({
            type: 'error',
            id: 'evt-' + Date.now(),
            timestamp: new Date().toISOString(),
            payload: { message: 'Topic name required' }
          }))
          return
        }
        
        const success = leaveTopic(d.payload.name)
        ws.send(JSON.stringify({
          type: success ? 'topic-left' : 'error',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: success ? { name: d.payload.name } : { message: 'Topic not found' }
        }))
      }
      else if (d.type === 'get_stats') {
        ws.send(JSON.stringify({
          type: 'stats',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: {
            peers: peers.size,
            agents: agents.size,
            clients: clients.size,
            topics: topics.size,
            messages: messages.length,
            uptime: process.uptime()
          }
        }))
      }
      else if (d.type === 'get_info') {
        ws.send(JSON.stringify({
          type: 'info',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: {
            publicKey: keyPair.publicKey.toString('hex'),
            mode: 'observatory',
            capabilities: [
              'websocket',
              'hyperswarm',
              'peer-discovery',
              'message-relay',
              'topic-management',
              'agent-registry',
              'message-archival',
              'network-observatory'
            ]
          }
        }))
      }
    } catch (err) {
      console.error('[ws] message parse error:', err.message)
    }
  })
  
  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[ws] client disconnected — ${clients.size} remaining`)
  })
})

swarm.on('connection', (conn, info) => {
  const peerId = info.publicKey.toString('hex')
  console.log('[swarm] peer connected:', peerId.slice(0, 8))
  
  // Determine which topic this connection is for
  const topicKey = info.topics && info.topics[0] ? info.topics[0].toString('hex') : null
  
  // Track peer
  if (!peers.has(peerId)) {
    peers.set(peerId, {
      publicKey: peerId,
      conn: conn,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        client: info.client || false,
        server: info.server || false
      },
      topics: new Set()
    })
  }
  
  const peer = peers.get(peerId)
  
  // Associate peer with topic
  if (topicKey && topics.has(topicKey)) {
    peer.topics.add(topicKey)
    topics.get(topicKey).peers.add(peerId)
    console.log(`[swarm] peer ${peerId.slice(0, 8)} joined topic ${topicKey.slice(0, 16)}`)
  }
  
  // Register as agent (basic registration from peer connection)
  registerAgent({
    publicKey: peerId,
    name: `Peer-${peerId.slice(0, 8)}`,
    type: 'peer',
    topics: Array.from(peer.topics),
    metadata: {
      client: info.client || false,
      server: info.server || false
    }
  })
  
  // Notify all frontend clients about the new peer
  const joinEvent = JSON.stringify({
    type: 'agent-join',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { 
      agentId: peerId, 
      publicKey: peerId,
      metadata: {
        client: info.client || false,
        server: info.server || false
      },
      topics: Array.from(peer.topics)
    }
  })
  
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(joinEvent)
  })
  
  conn.on('data', data => {
    // Update last seen
    if (peer) peer.lastSeen = new Date().toISOString()
    
    let msg
    try {
      msg = JSON.parse(data.toString())
      
      // Check for agent announcement
      if (msg.type === 'agent-announce' || msg.type === 'agent-metadata') {
        registerAgent({
          publicKey: peerId,
          name: msg.payload?.name || msg.name,
          type: msg.payload?.type || msg.type,
          capabilities: msg.payload?.capabilities || msg.capabilities || [],
          topics: Array.from(peer.topics),
          metadata: msg.payload?.metadata || msg.metadata || {}
        })
      }
      
      // Archive message
      archiveMessage({
        ...msg,
        topic: topicKey || 'unknown',
        sender: peerId
      })
      
    } catch {
      // Non-JSON message
      msg = {
        type: 'message',
        id: 'evt-' + Date.now(),
        timestamp: new Date().toISOString(),
        payload: { source: peerId, raw: data.toString('hex').slice(0, 64) }
      }
      
      archiveMessage({
        id: msg.id,
        timestamp: msg.timestamp,
        topic: topicKey || 'unknown',
        sender: peerId,
        content: data.toString('hex').slice(0, 64),
        metadata: { raw: true }
      })
    }
    
    // Broadcast to WebSocket clients
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    })
  })
  
  conn.on('close', () => {
    // Remove peer from topic tracking
    if (peer && peer.topics) {
      peer.topics.forEach(topicKey => {
        const topic = topics.get(topicKey)
        if (topic) {
          topic.peers.delete(peerId)
        }
      })
    }
    
    // Update agent last seen (don't remove from registry)
    if (agents.has(peerId)) {
      agents.get(peerId).lastSeen = new Date().toISOString()
    }
    
    // Remove peer from active tracking
    peers.delete(peerId)
    
    const leaveEvent = JSON.stringify({
      type: 'agent-leave',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { agentId: peerId }
    })
    
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(leaveEvent)
    })
    
    console.log('[swarm] peer disconnected:', peerId.slice(0, 8))
  })
  
  conn.on('error', err => console.error('[swarm] conn error:', err.message))
})

server.listen(8080, () => {
  console.log('[sc-bridge-observatory] ready — public key:', keyPair.publicKey.toString('hex'))
  console.log('[sc-bridge-observatory] HTTP + WebSocket listening on :8080')
  console.log('[sc-bridge-observatory] Mode: NETWORK OBSERVATORY')
  console.log('[sc-bridge-observatory] Auto-joined topics:', AUTO_JOIN_TOPICS.join(', '))
  console.log('[sc-bridge-observatory] Endpoints: /, /health, /peers, /agents, /messages, /activity, /graph, /clients, /topics, /network, /stats, /info')
})
