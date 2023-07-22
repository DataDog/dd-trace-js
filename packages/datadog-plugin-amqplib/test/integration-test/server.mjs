import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import amqplib from 'amqplib'

const amqpServerEndpoint = 'amqp://localhost:5672'
let channel

function connectToAMQP (endpoint) {
  return amqplib.connect(endpoint)
    .then(conn => {
      return conn.createChannel()
    })
    .then(ch => {
      channel = ch
    })
}

pluginHelpers.onMessage(async () => {
  await connectToAMQP(amqpServerEndpoint)
  channel.assertQueue('test', {}, () => {})
})
