'use strict'

const net = require('net')
const { port, reqs } = require('./common')

let connectionsMade = 0

const server = net.createServer(c => {
  if (++connectionsMade === reqs) {
    c.on('end', () => server.close())
  }
  c.pipe(c)
}).listen(port)
