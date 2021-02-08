'use strict'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}

const DD_TRACE_LIBRARY_REQUIRE = process.env.DD_TRACE_LIBRARY_REQUIRE || '../..'

require(DD_TRACE_LIBRARY_REQUIRE).init(options)

const http = require('http')

const server = http.createServer((req, res) => {
  res.end('hello, world\n')
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
