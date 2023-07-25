import 'dd-trace/init.js'
import Hapi from '@hapi/hapi'

const init = async () => {
  const server = Hapi.server({ port: 0, host: 'localhost' })
  server.route({ method: 'GET', path: '/', handler: (request, h) => 'hello, world\n' })
  await server.start()
  process.send({ port: server.info.port })
}

process.on('unhandledRejection', () => process.exit(1))

init()
