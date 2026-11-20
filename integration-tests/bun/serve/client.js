'use strict'

const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 10 })
const http = require('node:http')

tracer.trace('node.parent', () => {
  http.get(process.env.SERVER_URL, res => {
    res.resume()
    res.on('end', () => tracer._tracer._exporter._writer.flush(() => process.exit()))
  })
})
