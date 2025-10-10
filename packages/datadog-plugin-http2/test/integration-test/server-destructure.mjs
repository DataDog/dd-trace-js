import 'dd-trace/init.js'
import { createServer } from 'http2'
const http2 = { createServer }

const server = http2.createServer((req, res) => {
  res.end('Hello, HTTP/2!')
})

server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})

