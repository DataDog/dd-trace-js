import 'dd-trace/init.js'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'
import getPort from 'get-port';

(async () => {
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
      // if (server.bindAsync) {
      //   server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
      //     if (err) return reject(err)

      //     server.addService(TestService.service, service)
      //     server.start()

      //     resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
      //   })
      // } else {
      //   server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
      //   server.addService(TestService.service, service)
      //   server.start()

      //   resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
      // }
      server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
      server.addService(TestService.service, service)
      server.start()

      resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
    })
  }

  const client = await buildClient({
    getUnary: (_, callback) => callback()
  })

  client.getUnary({ first: 'foobar' }, () => {})

  if (server) {
    console.log('got inside')
    server.forceShutdown()
    // client.close()
  }
})()
console.log(1231, 'gonna exit')
