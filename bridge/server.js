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
  console.log('[swarm] peer connected:', info.publicKey.toString('hex').slice(0, 8))
  
  conn.on('data', data => {
    // Broadcast raw P2P events to all connected frontends
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(data.toString())
    })
  })
  
  conn.on('error', err => console.error('[swarm] conn error:', err.message))
})

server.listen(8080, () => {
  console.log('[sc-bridge] ready — public key:', keyPair.publicKey.toString('hex').slice(0, 16) + '...')
  console.log('[sc-bridge] HTTP + WebSocket listening on :8080')
})
