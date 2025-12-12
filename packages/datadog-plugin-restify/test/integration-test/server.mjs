import 'dd-trace/init.js'
import restify from 'restify'

const server = restify.createServer()

server.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
