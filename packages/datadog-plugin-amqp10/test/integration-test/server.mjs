import 'dd-trace/init.js'
import amqp from 'amqp10'

const client = new amqp.Client()
let sender

async function connectToAMQP () {
  await client.connect('amqp://admin:admin@localhost:5673')
  const handlers = await Promise.all([client.createSender('amq.topic')])
  sender = handlers[0]
}

await connectToAMQP()
sender.send({ key: 'value' })
sender.detach()

process.send({ port: -1 })
