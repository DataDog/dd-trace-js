'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('amqp10')

const test = require('tape')
const profile = require('../../dd-trace/test/profile')

test('amqp10 plugin should not leak', t => {
  const amqp = require('../../../versions/amqp10').get()
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
      const deferred = []

      let messageIdx = 0
      let operationIdx = 0

      for (let i = 0; i < 2000; i++) {
        const promise = new Promise((resolve, reject) => {
          deferred[i] = { resolve, reject }
        })

        deferred[i].promise = promise
      }

      receiver.on('message', () => {
        deferred[messageIdx++].resolve()
      })

      profile(t, operation, 200, 10)
        .then(() => receiver.detach())
        .then(() => sender.detach())
        .then(() => client.disconnect())

      function operation (done) {
        deferred[operationIdx++].promise.then(() => done())
        sender.send({ key: 'value' })
      }
    })
})
