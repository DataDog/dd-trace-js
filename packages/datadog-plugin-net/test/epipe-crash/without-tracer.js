'use strict'

const net = require('node:net')

const server = net.createServer((serverSocket) => {
  serverSocket.on('data', () => serverSocket.resetAndDestroy())
})

server.listen(0, () => {
  const port = server.address().port
  const client = new net.Socket()

  client.connect(port, 'localhost', () => {
    client.write('first')
    client.write('second')
    setTimeout(() => {
      client.write('third')
      client.write('fourth')
    }, 100)
  })

  setTimeout(() => {
    server.close()
    client.destroy()
    process.exit(0)
  }, 3000)
})
