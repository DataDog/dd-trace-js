import { createServer } from 'node:http'

const server = createServer((req, res) => {
  res.end('Hello, World!') // This needs to be line 4
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
