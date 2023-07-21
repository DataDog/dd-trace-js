import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import amqp from 'amqp10'

const amqpServerEndpoint = 'amqp://admin:admin@localhost:5673'

const client = new amqp.Client()
let sender

function connectToAMQP (endpoint) {
  return client.connect('amqp://admin:admin@localhost:5673')
    .then(() => {
      return Promise.all([
        client.createSender('amq.topic')
      ])
    })
    .then(handlers => {
      sender = handlers[0]
    })
}

pluginHelpers.onMessage(async () => {
  await connectToAMQP(amqpServerEndpoint)
  sender.send({ key: 'value' })
})
