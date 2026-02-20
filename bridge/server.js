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

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      publicKey: keyPair.publicKey.toString('hex').slice(0, 16) + '...',
      clients: clients.size,
      uptime: process.uptime()
    }))
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

// Attach WebSocket server to HTTP server
const wss = new WebSocketServer({ server })
const clients = new Set()

wss.on('connection', ws => {
  clients.add(ws)
  console.log(`[ws] client connected — ${clients.size} total`)
  
  ws.on('message', msg => {
    try {
      const d = JSON.parse(msg)
      if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
    } catch {}
  })
  
  ws.on('close', () => {
    clients.delete(ws)
    console.log(`[ws] client disconnected — ${clients.size} remaining`)
  })
})

swarm.on('connection', (conn, info) => {
  const peerId = info.publicKey.toString('hex')
  console.log('[swarm] peer connected:', peerId.slice(0, 8))
  
  // Notify all frontend clients about the new peer
  const joinEvent = JSON.stringify({
    type: 'agent-join',
    id: 'evt-' + Date.now(),
    timestamp: new Date().toISOString(),
    payload: { agentId: peerId, publicKey: peerId }
  })
  
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(joinEvent)
  })
  
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
    
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    })
  })
  
  conn.on('close', () => {
    const leaveEvent = JSON.stringify({
      type: 'agent-leave',
      id: 'evt-' + Date.now(),
      timestamp: new Date().toISOString(),
      payload: { agentId: peerId }
    })
    
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(leaveEvent)
    })
  })
  
  conn.on('error', err => console.error('[swarm] conn error:', err.message))
})

server.listen(8080, () => {
  console.log('[sc-bridge] ready — public key:', keyPair.publicKey.toString('hex').slice(0, 16) + '...')
  console.log('[sc-bridge] HTTP + WebSocket listening on :8080')
})
