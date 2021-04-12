'use strict'

const net = require('net')

let connectionsMade = 0
const server = net.createServer(c => {
  if (++connectionsMade === 10000) {
    c.on('end', () => server.close())
  }
  c.pipe(c)
}).listen(process.env.PORT)
