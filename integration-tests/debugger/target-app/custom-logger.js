'use strict'

require('dd-trace').init({
  logger: {
    error: (...args) => console.log('[CUSTOM LOGGER][ERROR]:', ...args), // eslint-disable-line no-console
    warn: (...args) => console.log('[CUSTOM LOGGER][WARN]:', ...args), // eslint-disable-line no-console
    info: (...args) => console.log('[CUSTOM LOGGER][INFO]:', ...args), // eslint-disable-line no-console
    debug: (...args) => console.log('[CUSTOM LOGGER][DEBUG]:', ...args) // eslint-disable-line no-console
  }
})

const http = require('http')

const server = http.createServer((req, res) => {
  res.end('hello world') // BREAKPOINT: /
  setImmediate(() => {
    server.close()
  })
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
