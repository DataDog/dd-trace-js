import 'dd-trace/init.js'
import amqplib from 'amqplib'

const connection = await amqplib.connect('amqp://localhost:5672')
const channel = await connection.createChannel()

await channel.assertQueue('test', {})

if (channel) {
  await channel.close()
}
if (connection) {
  await connection.close()
}

