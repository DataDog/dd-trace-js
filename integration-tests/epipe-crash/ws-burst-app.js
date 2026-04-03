'use strict'

// Integration test app: WebSocket server with high-frequency sends.
// Simulates the customer scenario: tracer active, ws integration enabled,
// many websocket.send spans generated in bursts, with clients disconnecting.

const tracer = require('../../packages/dd-trace')
tracer.init({
  flushInterval: 100, // Flush frequently to stress the agent connection
})

const WebSocket = require('../../versions/ws@8.0.0/node_modules/ws')
const http = require('http')

const httpServer = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('ok')
})

const wss = new WebSocket.Server({ server: httpServer })

wss.on('connection', (ws) => {
  // Burst send large payloads to generate many websocket.send spans
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval)
      return
    }
    try {
      ws.send(Buffer.alloc(4096, 'x').toString())
    } catch {
      clearInterval(interval)
    }
  }, 1)

  ws.on('close', () => clearInterval(interval))
  ws.on('error', () => clearInterval(interval))
})

httpServer.listen(0, () => {
  const port = httpServer.address().port

  // Spawn clients that connect and abruptly disconnect
  function spawnClient () {
    const client = new WebSocket(`ws://localhost:${port}`)
    client.on('error', () => {})
    client.on('open', () => {
      // Abruptly disconnect after a short time
      setTimeout(() => {
        client.terminate()
      }, 100 + Math.random() * 200)
    })
    client.on('close', () => {
      // Reconnect after a short delay (continuous churn)
      setTimeout(spawnClient, 50)
    })
  }

  // Start several clients
  for (let i = 0; i < 5; i++) {
    spawnClient()
  }

  // Run for a few seconds then exit cleanly
  setTimeout(() => {
    wss.close()
    httpServer.close()
    process.stdout.write('OK\n')
    process.exit(0)
  }, 5000)
})
