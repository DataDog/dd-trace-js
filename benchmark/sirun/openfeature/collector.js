'use strict'

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const consent = process.argv[2] === 'true'
let collected = 0
let rows = 0
let bytes = 0
let privacyValid = true

// Keep intake acknowledgments independent of expensive SDK context merging on the measured application thread.
const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    try {
      assert.strictEqual(request.url, '/evp_proxy/v2/api/v2/flagevaluation')
      const payload = JSON.parse(body)
      for (const row of payload.flagEvaluations) {
        collected += row.evaluation_count
        privacyValid &&= (row.context !== undefined) === consent
        privacyValid &&= row.targeting_key?.startsWith('sha256_') === !consent
      }
      if (!consent) privacyValid &&= !body.includes('benchmark-customer')
      rows += payload.flagEvaluations.length
      bytes += Buffer.byteLength(body)
      response.writeHead(202).end()
      process.send({ type: 'stats', collected, rows, bytes, privacyValid })
    } catch (error) {
      process.send({ type: 'error', message: error.stack })
      response.writeHead(500).end()
    }
  })
})

server.on('error', error => {
  process.send({ type: 'error', message: error.stack })
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port })
})
function close () {
  server.closeAllConnections()
  server.close(() => {
    if (process.connected) process.disconnect()
  })
}
process.once('message', close)
process.once('disconnect', close)
