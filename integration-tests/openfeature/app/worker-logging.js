'use strict'

const { createServer } = require('node:http')

globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }
const getConfig = require('../../../packages/dd-trace/src/config')
const { errorRecordChannel } = require('../../../packages/dd-trace/src/log/channels')
const Writer = require('../../../packages/dd-trace/src/openfeature/writers/flag-evaluations')

const logs = []
const telemetryErrors = []
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
  level, message => logs.push({ level, message: message instanceof Error ? message.stack : String(message) }),
]))
const config = getConfig({ logger, logLevel: process.argv[2] })
errorRecordChannel.subscribe(record => {
  if (record.sendViaTelemetry) telemetryErrors.push(record.message)
})

let writer
let requests = 0
// The route notification precedes its error log. Wait for the worker's drain before reporting.
process.once('beforeExit', () => {
  process.stdout.write(JSON.stringify({ logs, telemetryErrors, requests }))
})
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (++requests === 1) {
      res.once('finish', () => {
        writer.enqueue({ flagKey: 'second', timestamp: 200 })
        writer.flush()
      })
      res.writeHead(202).end()
    } else {
      req.socket.destroy()
    }
  })
})
server.listen(0, '127.0.0.1', () => {
  const url = new URL('http://127.0.0.1:' + server.address().port)
  writer = new Writer({ ...config, url, service: 'worker-logging-test' })
  writer.setEnabled(true, {
    url,
    basePath: '',
    onUnavailable: () => {
      writer.destroy()
      server.close()
    },
  })
  writer.enqueue({ flagKey: 'first', timestamp: 100 })
  writer.flush()
})
