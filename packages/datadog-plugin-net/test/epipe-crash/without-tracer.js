'use strict'

const net = require('net')

const server = net.createServer((serverSocket) => {
  serverSocket.destroy()
})

server.listen(0, () => {
  const port = server.address().port
  const socket = new net.Socket()

  socket.connect(port, 'localhost', () => {
    setImmediate(() => {
      socket.write('trigger socket error')
    })
  })

  // No 'error' listener — process should crash
  setTimeout(() => {
    socket.destroy()
    server.close()
    process.exit(0)
  }, 3000)
})
