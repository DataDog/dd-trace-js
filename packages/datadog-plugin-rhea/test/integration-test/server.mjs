import 'dd-trace/init.js'
import rhea from 'rhea'

const connection = rhea.connect({
  username: 'admin',
  password: 'admin',
  host: 'localhost',
  port: 5673
})
let sender = connection.open_sender('amq.topic')

function connectToAMQP () {
  return new Promise((resolve, reject) => {
    connection.on('connection_open', (context) => {
      sender = context.connection.open_sender('amq.topic')
    })

    connection.on('sendable', () => {
      resolve()
    })

    connection.on('error', (error) => {
      reject(error)
    })
  })
}

await connectToAMQP()
sender.send({ body: 'Hello World!' })

process.send({ port: -1 })
