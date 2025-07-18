'use strict'

require('dd-trace').init({
  logger: {
    error: err => console.error(err), // eslint-disable-line no-console
    warn: message => console.warn(message), // eslint-disable-line no-console
    info: message => console.info(message), // eslint-disable-line no-console
    debug: message => console.debug(message) // eslint-disable-line no-console
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
