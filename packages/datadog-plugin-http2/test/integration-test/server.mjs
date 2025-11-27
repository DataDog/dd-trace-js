import 'dd-trace/init.js'
import http2 from 'http2'

const server = http2.createServer((req, res) => {
  res.end('Hello, HTTP/2!')
})

server.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
