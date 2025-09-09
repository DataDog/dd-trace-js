import 'dd-trace/init.js'
import { connect } from 'amqplib'

const connection = await connect('amqp://localhost:5672')
const channel = await connection.createChannel()

await channel.assertQueue('test', {})

if (channel) {
  await channel.close()
}
if (connection) {
  await connection.close()
}
