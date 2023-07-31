import 'dd-trace/init.js'
import grpc from 'grpc'
import loader from '@grpc/proto-loader'
import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import getPort from 'get-port'

// Get the current module's URL
const __filename = fileURLToPath(import.meta.url)

// Get the directory name from the URL
const __dirname = dirname(__filename)

let server

async function buildClient (service, port) {
  service = Object.assign(
    {
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {}
    },
    service
  )

  const protoPath = resolve(__dirname, '../test.proto')
  const definition = loader.loadSync(protoPath)
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

async function runTest () {
  try {
    const port = await getPort()
    const client = await buildClient(
      {
        getUnary: (_, callback) => callback()
      },
      port
    )

    client.getUnary({ first: 'foobar' }, () => {})

    // client.close()

    server.forceShutdown()

    console.log('Client connection closed gracefully.')
  } catch (error) {
    console.error('Error occurred during the test:', error)
  }
}

runTest()
