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

// Track connected peers with metadata
const peers = new Map() // peerId -> { publicKey, conn, connectedAt, lastSeen, metadata, topics }

// Track topics/channels
const topics = new Map() // topicKey -> { name, key, discovery, peers: Set(), joinedAt }
const topicDiscoveries = new Map() // topicKey -> discovery object from swarm

// Discovery topic for announcing public channels
const DISCOVERY_TOPIC = 'sc-bridge-discovery'
// Create 32-byte key from topic name using hash
const topicHash = require('crypto').createHash('sha256').update(DISCOVERY_TOPIC).digest()
const discoveryTopicKey = crypto.discoveryKey(topicHash)

// Helper: Create topic key from name
function getTopicKey(topicName) {
  // Hash the topic name to create a 32-byte key
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
    server: options.server !== false, // default true
    client: options.client !== false  // default true
  })
  
  topics.set(topicKeyHex, {
    name: topicName,
    key: topicKeyHex,
    discovery: discovery,
    peers: new Set(),
    joinedAt: new Date().toISOString(),
    server: options.server !== false,
    client: options.client !== false
  })
  
  topicDiscoveries.set(topicKeyHex, discovery)
  
  console.log(`[topic] joined: ${topicName} (${topicKeyHex.slice(0, 16)}...)`)
  
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
  
  // Only notify clients if they exist (after WebSocket server is initialized)
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
  
  // Notify WebSocket clients
  const leaveEvent = JSON.stringify({
    type: 'topic-left',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: {
      name: topicName,
      key: topicKeyHex
    }
  })
  
  // Only notify clients if they exist (after WebSocket server is initialized)
  if (typeof clients !== 'undefined') {
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(leaveEvent)
    })
  }
  
  return true
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
      uptime: process.uptime()
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
    // List all joined topics
    const topicList = Array.from(topics.values()).map(t => ({
      name: t.name,
      key: t.key,
      peers: Array.from(t.peers),
      peerCount: t.peers.size,
      joinedAt: t.joinedAt,
      server: t.server,
      client: t.client
    }))
    res.writeHead(200)
    res.end(JSON.stringify({
      count: topicList.length,
      topics: topicList
    }))
  }
  else if (req.url.startsWith('/topics/')) {
    // Get specific topic details
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
      client: topic.client
    }))
  }
  else if (req.url === '/network') {
    res.writeHead(200)
    res.end(JSON.stringify({
      bridge: {
        publicKey: keyPair.publicKey.toString('hex'),
        uptime: Date.now() - startTime,
        startedAt: new Date(startTime).toISOString()
      },
      peers: {
        count: peers.size,
        list: Array.from(peers.keys())
      },
      clients: {
        count: clients.size
      },
      topics: {
        count: topics.size,
        list: Array.from(topics.values()).map(t => ({
          name: t.name,
          key: t.key,
          peerCount: t.peers.size
        }))
      }
    }))
  }
  else if (req.url === '/stats') {
    res.writeHead(200)
    res.end(JSON.stringify({
      bridge: {
        publicKey: keyPair.publicKey.toString('hex'),
        uptime: process.uptime(),
        startedAt: new Date(startTime).toISOString()
      },
      connections: {
        peers: peers.size,
        clients: clients.size,
        topics: topics.size,
        total: peers.size + clients.size
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
      name: 'sc-bridge',
      version: '2.0.0',
      publicKey: keyPair.publicKey.toString('hex'),
      capabilities: ['websocket', 'hyperswarm', 'peer-discovery', 'message-relay', 'topic-management'],
      endpoints: ['/', '/health', '/peers', '/clients', '/topics', '/topics/:key', '/network', '/stats', '/info'],
      websocketCommands: ['ping', 'list_peers', 'get_stats', 'get_info', 'list_topics', 'join_topic', 'leave_topic']
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

// Join discovery topic after clients is initialized
joinTopic(DISCOVERY_TOPIC, { server: true, client: true })

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
  
  // Send current topic list
  const topicList = Array.from(topics.values()).map(t => ({
    name: t.name,
    key: t.key,
    peerCount: t.peers.size,
    joinedAt: t.joinedAt
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
      else if (d.type === 'list_topics') {
        const topicData = Array.from(topics.values()).map(t => ({
          name: t.name,
          key: t.key,
          peerCount: t.peers.size,
          peers: Array.from(t.peers),
          joinedAt: t.joinedAt
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
            clients: clients.size,
            topics: topics.size,
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
            capabilities: ['websocket', 'hyperswarm', 'peer-discovery', 'message-relay', 'topic-management']
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
  
  // Only notify clients if they exist (after WebSocket server is initialized)
  if (typeof clients !== 'undefined') {
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(joinEvent)
    })
  }
  
  conn.on('data', data => {
    // Update last seen
    if (peer) peer.lastSeen = new Date().toISOString()
    
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
    
    // Remove peer from tracking
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
  console.log('[sc-bridge] ready — public key:', keyPair.publicKey.toString('hex'))
  console.log('[sc-bridge] HTTP + WebSocket listening on :8080')
  console.log('[sc-bridge] Endpoints: /, /health, /peers, /clients, /topics, /network, /stats, /info')
  console.log('[sc-bridge] Discovery topic:', DISCOVERY_TOPIC)
})
