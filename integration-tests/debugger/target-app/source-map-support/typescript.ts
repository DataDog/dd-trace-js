require('dd-trace/init')

import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { sayHello } from './hello/world'

const server = createServer((req, res) => {
  // Blank lines below to ensure line numbers in transpiled file differ from original file


  res.end(sayHello()) // BREAKPOINT: /
})

server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: (server.address() as AddressInfo).port })
})
