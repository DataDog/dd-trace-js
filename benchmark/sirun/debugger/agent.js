'use strict'

// Minimal agent stand-in for the Dynamic Instrumentation benchmark.
// `debugger.start()` queries `/info` to choose the diagnostics upload route and
// blocks on it (~15s connection-retry budget) when no agent answers. Answer
// `/info` immediately and drain the diagnostics/input uploads so the benchmark
// measures probe overhead, not agent discovery.
//
// CI runs the variants in parallel, each pinned to its own core via
// `$CPU_AFFINITY`. Derive the port from the core (like `plugin-http`'s
// `3031 + CPU_AFFINITY`) so every variant gets a private agent; sharing one port
// leaves the losers of the bind race with no agent, and they then burn the ~15s
// retry budget per process. `app.js`'s agent URL derives the same port. Unset
// affinity (local, sequential runs) falls back to the conventional 8080.
const http = require('node:http')

const port = 8080 + Number(process.env.CPU_AFFINITY || 0)
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
