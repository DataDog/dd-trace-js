'use strict'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}

require('dd-trace').init(options)

// https://www.npmjs.com/package/stealthy-require
if (process.env.STEALTHY_REQUIRE === 'true') {
  // emulate stealthy-require
  for (const key in require.cache) {
    delete require.cache[key]
  }

  // require module known to break with stealthy-require
  require('net')
}

const http = require('http')

const server = http.createServer((req, res) => {
  res.end('hello, world\n')
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
