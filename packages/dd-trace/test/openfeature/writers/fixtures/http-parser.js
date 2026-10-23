'use strict'

const { createServer } = require('node:net')

globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
const Writer = require('../../../../src/openfeature/writers/flag-evaluations')
const telemetry = require('../../../../src/telemetry/metrics')

let requests = 0
process.on('exit', () => {
  const metrics = telemetry.manager.namespace('general').toJSON().metrics?.series ?? []
  const failures = metrics.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
    metric.tags.includes('reason:delivery_failure'))
  process.stdout.write(JSON.stringify({ requests, failures: failures?.points[0][1] ?? 0 }))
})

// A raw server is needed because node:http refuses to send this invalid header value.
const server = createServer(socket => {
  socket.once('data', () => {
    requests++
    socket.end('HTTP/1.1 202 Accepted\r\nX-Probe: bad\x01value\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    server.close()
  })
})
server.listen(0, '127.0.0.1', () => {
  const url = new URL('http://127.0.0.1:' + /** @type {import('node:net').AddressInfo} */ (server.address()).port)
  const writer = new Writer(/** @type {import('../../../../src/config/config-base')} */ ({ url }))
  writer.setEnabled(true, { url, basePath: '' })
  writer.enqueue({ flagKey: 'parser-probe', timestamp: 100, runtimeDefault: false })
  writer.destroy()
})
