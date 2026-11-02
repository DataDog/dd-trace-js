// Initializes the tracer first, as an application would. The bundle still loads the built-ins imported below before
// the tracer initializes, so tracing them relies on dd-trace patching already loaded built-ins.
import './init.mjs'

import { execFileSync } from 'node:child_process'
import http from 'node:http'

const server = http.createServer((req, res) => {
  if (req.url === '/downstream') {
    res.end('downstream')
    return
  }

  execFileSync(process.execPath, ['--version'])

  http.get(`http://127.0.0.1:${server.address().port}/downstream`, (downstream) => {
    downstream.resume()
    downstream.on('end', () => res.end('ok'))
  })
})

server.listen(0, () => {
  process.send?.({ port: server.address().port })
})
