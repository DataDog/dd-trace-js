require('dd-trace/init')

import { createServer } from 'node:http'

const server = createServer((req, res) => {
  // Blank lines below to ensure line numbers in transpiled file differ from original file


  res.end('hello world') // BREAKPOINT: /
})

server.listen(process.env.APP_PORT, () => {
  process.send?.({ port: process.env.APP_PORT })
})
