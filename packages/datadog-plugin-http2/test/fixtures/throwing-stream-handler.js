'use strict'

require('../../../dd-trace').init().use('http2', { client: false })

const http2 = require('http2')

const server = http2.createServer()
server.on('stream', () => {
  throw new Error('expected stream handler failure')
})
server.listen(0, '127.0.0.1', () => {
  const client = http2.connect(`http://127.0.0.1:${server.address().port}`)
  client.on('error', () => {})

  const request = client.request({ ':path': '/' })
  request.on('error', () => {})
  request.end()
})

setTimeout(() => {
  throw new Error('HTTP/2 stream handler did not throw')
}, 5_000)
