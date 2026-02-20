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
  fs.mkdirSync('/data', { recursive: true})
  fs.writeFileSync(KEYFILE, seed)
  keyPair = crypto.keyPair(seed)
}

const swarm = new Hyperswarm({ keyPair })
const startTime = Date.now()

// Track connected peers with metadata
const peers = new Map() // peerId -> { publicKey, conn, connectedAt, lastSeen, metadata }

// Create HTTP server with multiple endpoints
const server = http.createServer((req, res) => {
  // Add CORS headers for all requests
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
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
    // List all connected Hyperswarm peers with full details
    const peerList = Array.from(peers.values()).map(p => ({
      id: p.publicKey,
      publicKey: p.publicKey,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen,
      uptime: Date.now() - new Date(p.connectedAt).getTime(),
      metadata: p.metadata || {}
    }))
    res.writeHead(200)
    res.end(JSON.stringify({
      count: peerList.length,
      peers: peerList
    }))
  }
  else if (req.url === '/clients') {
    // List all connected WebSocket clients
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
  else if (req.url === '/network') {
    // Network statistics
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
      }
    }))
  }
  else if (req.url === '/stats') {
    // Detailed stats
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
        total: peers.size + clients.size
      },
      peers: Array.from(peers.values()).map(p => ({
        id: p.publicKey.slice(0, 16) + '...',
        uptime: Date.now() - new Date(p.connectedAt).getTime()
      }))
    }))
  }
  else if (req.url === '/info') {
    // Bridge capabilities and information
    res.writeHead(200)
    res.end(JSON.stringify({
      name: 'sc-bridge',
      version: '1.0.0',
      publicKey: keyPair.publicKey.toString('hex'),
      capabilities: ['websocket', 'hyperswarm', 'peer-discovery', 'message-relay'],
      endpoints: ['/', '/health', '/peers', '/clients', '/network', '/stats', '/info'],
      websocketCommands: ['ping', 'list_peers', 'get_stats', 'get_info']
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
      metadata: p.metadata || {}
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
          metadata: p.metadata || {}
        }))
        ws.send(JSON.stringify({
          type: 'peer-list',
          id: 'evt-' + Date.now(),
          timestamp: new Date().toISOString(),
          payload: { peers: peerData }
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
            capabilities: ['websocket', 'hyperswarm', 'peer-discovery', 'message-relay']
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
  
  // Track peer
  peers.set(peerId, {
    publicKey: peerId,
    conn: conn,
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
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
      }
    }
  })
  
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(joinEvent)
  })
  
  conn.on('data', data => {
    // Update last seen
    const peer = peers.get(peerId)
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
  console.log('[sc-bridge] Endpoints: /, /health, /peers, /clients, /network, /stats, /info')
})
