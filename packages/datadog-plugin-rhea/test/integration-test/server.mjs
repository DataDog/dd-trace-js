import 'dd-trace/init.js'
import rhea from 'rhea'

async function connectToAMQP () {
  return new Promise((resolve, reject) => {
    const connection = rhea.connect({
      username: 'admin',
      password: 'admin',
      host: 'localhost',
      port: 5673
    })

    connection.on('connection_open', (context) => {
      const sender = context.connection.open_sender('amq.topic')
      const receiver = context.connection.open_receiver('amq.topic')

      context.sender = sender
      context.receiver = receiver
      resolve(context)
    })

    connection.on('error', (error) => {
      reject(error)
    })

    connection.on('connection_close', () => {
      if (!connection._closing) {
        connection._closing = true
        resolve()
      }
    })
  })
}

async function runIntegrationTest () {
  const context = await connectToAMQP()
  context.sender.send({ body: 'Hello World!' })

  await new Promise((resolve) => {
    context.connection.once('connection_close', () => {
      resolve()
    })
    context.connection.close()
  })
}

runIntegrationTest()
