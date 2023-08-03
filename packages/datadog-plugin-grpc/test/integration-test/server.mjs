import 'dd-trace/init.js'
import grpc from '@grpc/grpc-js'
import loader from '@grpc/proto-loader'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import getPort from 'get-port'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let server
const port = await getPort()

function buildClient (service, callback) {
  service = Object.assign({
    getBidi: () => {},
    getServerStream: () => {},
    getClientStream: () => {},
    getUnary: () => {}
  }, service)

  const protoPath = resolve(__dirname, '../test.proto');
  const definition = loader.loadSync(protoPath);
  const TestService = grpc.loadPackageDefinition(definition).test.TestService

  server = new grpc.Server()

  return new Promise((resolve, reject) => {
    if (server.bindAsync) {
      server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) return reject(err)

        server.addService(TestService.service, service)
        server.start()

        resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
      })
    } else {
      server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
      server.addService(TestService.service, service)
      server.start()

      resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
    }
  })
}

const client = await buildClient({
  getUnary: (_, callback) => callback()
})

await client.getUnary({ first: 'foobar' }, () => {})

await client.close()

if (server) {
  await server.forceShutdown();
}
