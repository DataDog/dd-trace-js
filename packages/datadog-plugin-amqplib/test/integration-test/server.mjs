import 'dd-trace/init.js'
import amqplib from 'amqplib'

const amqpServerEndpoint = 'amqp://localhost:5672'
let channel
let connection

async function connectToAMQP (endpoint) {
  connection = await amqplib.connect(endpoint)
  channel = await connection.createChannel()
}

await connectToAMQP(amqpServerEndpoint)
await channel.assertQueue('test', {})

if (channel) {
  await channel.close()
}
if (connection) {
  await connection.close()
}
