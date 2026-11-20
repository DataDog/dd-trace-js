'use strict'

const assert = require('node:assert/strict')

// This fixture runs under Bun, which implements WebSocket independently of Node.js.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const ws = new WebSocket(process.env.SERVER_URL.replace('http:', 'ws:') + '/ws')
let echoed = false
ws.addEventListener('error', error => { throw error }, { once: true })
ws.addEventListener('open', () => ws.send('hello'), { once: true })
ws.addEventListener('message', ({ data }) => {
  assert.strictEqual(data, 'hello')
  echoed = true
  ws.close()
}, { once: true })
ws.addEventListener('close', () => assert.ok(echoed), { once: true })
