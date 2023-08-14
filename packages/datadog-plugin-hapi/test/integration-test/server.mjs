import 'dd-trace/init.js'
import Hapi from '@hapi/hapi'

const server = Hapi.server({ port: 0, host: 'localhost' })
server.route({ method: 'GET', path: '/', handler: (request, h) => 'foo\n' })
await server.start()
process.send({ port: server.info.port })
