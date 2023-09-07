import 'dd-trace/init.js'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'
import getPort from 'get-port'

const currentDirectoryPath = path.dirname(new URL(import.meta.url).pathname)
const parentDirectoryPath = path.resolve(currentDirectoryPath, '..')

let server
const port = await getPort()

function buildClient (service, callback) {
  service = Object.assign(
    {
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {}
    },
    service
  )

  const definition = protoLoader.loadSync(`${parentDirectoryPath}/test.proto`)
  const TestService = grpc.loadPackageDefinition(definition).test.TestService

  server = new grpc.Server()

  return new Promise((resolve, reject) => {
    if (server.bindAsync) {
      server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
        if (err) return reject(err)

        server.addService(TestService.service, service)
        server.start()

        resolve(new TestService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
      })
    } else {
      server.bind(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure())
      server.addService(TestService.service, service)
      server.start()

      resolve(new TestService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
    }
  })
}

const client = await buildClient({
  getUnary: (_, callback) => callback()
})

client.getUnary({ first: 'foobar' }, () => {})

if (server) {
  await server.forceShutdown()
}

// this is to gracefully exit the process and flush the traces to the agent which doesn't happen using process.exit()
// or when manually closing the client and letting the process finish by itself
process.send({ port })
