'use strict'

// Minimal agent stand-in for the Dynamic Instrumentation benchmark.
// `debugger.start()` queries `/info` to choose the diagnostics upload route and
// blocks on it (~16s connection timeout) when no agent answers. Answer `/info`
// immediately and drain the diagnostics/input uploads so the benchmark measures
// probe overhead, not agent discovery.
const http = require('node:http')

const port = Number(process.env.AGENT_PORT) || 8080
const info = JSON.stringify({ endpoints: ['/debugger/v1/diagnostics', '/debugger/v2/input'] })

http.createServer((req, res) => {
  if (req.url === '/info') {
    res.setHeader('content-type', 'application/json')
    res.end(info)
    return
  }
  // Drain and acknowledge diagnostics / snapshot uploads.
  req.on('data', () => {})
  req.on('end', () => res.end())
}).listen(port)
