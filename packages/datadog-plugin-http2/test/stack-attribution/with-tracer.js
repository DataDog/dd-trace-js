'use strict'

const tracer = require('../../../dd-trace')
tracer.init({
  plugins: false,
})
tracer.use('http2')

// eslint-disable-next-line import/order
const http2 = require('node:http2')

const server = http2.createServer()
server.on('stream', (stream) => {
  stream.respond({ ':status': 200 })
  stream.end('payload')
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const client = http2.connect(`http://127.0.0.1:${port}`)
  const req = client.request({ ':path': '/' })

  req.on('response', () => {
    req.on('data', () => {
      throw new Error('crash from data listener')
    })
  })

  setTimeout(() => {
    server.close()
    client.close()
    process.exit(0)
  }, 3000)
})
