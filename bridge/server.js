const Hyperswarm = require('hyperswarm')
const { WebSocketServer } = require('ws')
const crypto = require('hypercore-crypto')
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
const wss = new WebSocketServer({ port: 8080 })
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

console.log('[sc-bridge] ready — public key:', keyPair.publicKey.toString('hex').slice(0, 16) + '...')
console.log('[sc-bridge] WebSocket listening on :8080')
