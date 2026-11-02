'use strict'

const { createServer } = require('node:http')

globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
const Writer = require('../../../../src/openfeature/writers/flag-evaluations')
const BaseWriter = require('../../../../src/openfeature/writers/base')
const logWriter = require('../../../../src/log/writer')

const mode = process.argv[2]
const logs = []
const bodies = []
const capture = message => logs.push(String(message))
logWriter.configure(mode !== 'disabled', 'debug', { debug: capture, error: capture, warn: capture, info: capture })
process.on('exit', () => process.stdout.write(JSON.stringify({ logs, bodies })))

const server = createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    bodies.push(body)
    const fallback = mode === 'fallback' && bodies.length === 1
    response.writeHead(fallback ? 404 : mode === 'unavailable' ? 503 : 400, { Connection: 'close' })
    response.end('response-body-canary: ' + body)
    if (!fallback) server.close()
  })
})
server.listen(0, '127.0.0.1', () => {
  const url = new URL('http://127.0.0.1:' + /** @type {import('node:net').AddressInfo} */ (server.address()).port)
  const config = /** @type {import('../../../../src/config/config-base')} */ ({ url, debug: mode !== 'disabled' })
  if (mode === 'legacy') {
    const writer = new BaseWriter({ config, endpoint: '/legacy' })
    writer.append({ targetingKey: 'targeting-key-canary' })
    writer.destroy()
    return
  }
  const writer = new Writer(config)
  writer.setEnabled(true, {
    url,
    basePath: '',
    onUnavailable: mode === 'unavailable' ? () => {} : undefined,
    fallback: mode === 'fallback' ? { url, basePath: '' } : undefined,
  })
  writer.enqueue({
    flagKey: 'logging-probe',
    targetingKey: 'targeting-key-canary',
    attrs: { email: 'context-value-canary' },
    observeFullEvaluationData: mode !== 'protected',
    timestamp: 100,
    runtimeDefault: false,
  })
  writer.destroy()
})
