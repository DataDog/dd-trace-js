import 'dd-trace/init.js'
import Hapi from '@hapi/hapi'

const hapiServer = Hapi.server({ port: 0, host: 'localhost' })
hapiServer.route({ method: 'GET', path: '/', handler: (request, h) => 'foo\n' })
await hapiServer.start()
process.send({ port: hapiServer.info.port })
