import 'dd-trace/init.js'
import { createServer } from 'http2'

const server = createServer((req, res) => {
  res.end('Hello, HTTP/2!')
})

server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
