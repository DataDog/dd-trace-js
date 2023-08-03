import 'dd-trace/init.js'
import amqp from 'amqp10'

const client = new amqp.Client()
await client.connect('amqp://admin:admin@localhost:5673')
const handlers = await Promise.all([client.createSender('amq.topic')])
const sender = handlers[0]

sender.send({ key: 'value' })

if (sender) {
  await sender.detach()
}
if (client) {
  await client.disconnect()
}