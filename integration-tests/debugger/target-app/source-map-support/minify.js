require('dd-trace/init')

const { createServer } = require('node:http')

const server = createServer((req, res) => {
  res.end('hello world') // BREAKPOINT: /
})

server.listen(process.env.APP_PORT, () => {
  process.send?.({ port: process.env.APP_PORT })
})
