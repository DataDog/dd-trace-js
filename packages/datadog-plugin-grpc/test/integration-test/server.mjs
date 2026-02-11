import 'dd-trace/init.js'
import path from 'path'
import grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const currentDirectoryPath = path.dirname(new URL(import.meta.url).pathname)

let server
let port = 0

function buildClient (service, callback) {
  service = {
    getBidi: () => {},
    getServerStream: () => {},
    getClientStream: () => {},
    getUnary: () => {},
    ...service,
  }

  const definition = protoLoader.loadSync(`${currentDirectoryPath}/test.proto`)
  const TestService = grpc.loadPackageDefinition(definition).test.TestService

  server = new grpc.Server()

  return new Promise((resolve, reject) => {
    if (server.bindAsync) {
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) return reject(err)
        port = boundPort

        server.addService(TestService.service, service)
        server.start()

        resolve(new TestService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
      })
    } else {
      port = server.bind('127.0.0.1:0', grpc.ServerCredentials.createInsecure())
      server.addService(TestService.service, service)
      server.start()

      resolve(new TestService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
    }
  })
}

const client = await buildClient({
  getUnary: (_, callback) => callback(),
})

client.getUnary({ first: 'foobar' }, () => {})

if (server) {
  await server.forceShutdown()
}

// this is to gracefully exit the process and flush the traces to the agent which doesn't happen using process.exit()
// or when manually closing the client and letting the process finish by itself
process.send({ port })
