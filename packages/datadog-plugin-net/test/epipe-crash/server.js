'use strict'

// Standalone reproduction script for socket error crash with dd-trace net instrumentation.
// When dd-trace wraps Socket.emit, unhandled socket errors (EPIPE/ECONNRESET)
// crash the process because the error is emitted through the wrapped emit
// without any error listener attached.

const tracer = require('../../../dd-trace')
tracer.init({
  plugins: false,
})
tracer.use('net')
tracer.use('dns')

const net = require('net')

const server = net.createServer((serverSocket) => {
  // Destroy server-side socket immediately to trigger ECONNRESET/EPIPE on client write
  serverSocket.destroy()
})

server.listen(0, () => {
  const port = server.address().port
  const socket = new net.Socket()

  socket.connect(port, 'localhost', () => {
    setImmediate(() => {
      // Write after the server has destroyed its end — triggers EPIPE or ECONNRESET
      socket.write('trigger socket error')
    })
  })

  // Intentionally NO 'error' listener on this socket.
  // Without dd-trace: Node.js throws from internal emit — same crash behavior.
  // With dd-trace: the crash stack trace points to net.js:65 in dd-trace,
  // which may bypass process-level error handling in some applications.

  // If the process survives for 2 seconds without crashing, the fix works.
  setTimeout(() => {
    socket.destroy()
    server.close()
    process.stdout.write('OK\n')
    process.exit(0)
  }, 2000)
})
