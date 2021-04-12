'use strict'

const net = require('net')
const { port } = require('./common')

let connectionsMade = 0

const server = net.createServer(c => {
  if (++connectionsMade === 10000) {
    c.on('end', () => server.close())
  }
  c.pipe(c)
}).listen(port)
