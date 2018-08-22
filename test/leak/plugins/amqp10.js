'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('amqp10')

const test = require('tape')
const profile = require('../../profile')

test('amqp10 plugin should not leak', t => {
  const amqp = require('amqp10')
  const client = new amqp.Client()

  return client.connect('amqp://admin:admin@localhost:5673')
    .then(() => {
      return Promise.all([
        client.createReceiver('amq.topic'),
        client.createSender('amq.topic')
      ])
    })
    .then(handlers => {
      const receiver = handlers[0]
      const sender = handlers[1]

      profile(t, operation)
        .then(() => receiver.detach())
        .then(() => sender.detach())
        .then(() => client.disconnect())

      function operation (done) {
        sender.send({ key: 'value' })
        receiver.once('message', done)
      }
    })
})
