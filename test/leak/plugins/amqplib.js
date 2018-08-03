'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('amqplib')

const test = require('tape')
const profile = require('../../profile')

test('amqplib plugin should not leak when using callbacks', t => {
  require('amqplib/callback_api')
    .connect((err, conn) => {
      if (err) return t.fail(err)

      conn.createChannel((err, ch) => {
        if (err) return t.fail(err)

        profile(t, operation).then(() => conn.close())

        function operation (done) {
          ch.assertQueue('test', {}, done)
        }
      })
    })
})

test('amqplib plugin should not leak when using promises', t => {
  require('amqplib').connect()
    .then(conn => {
      return conn.createChannel()
        .then(ch => {
          profile(t, operation).then(() => conn.close())

          function operation (done) {
            ch.assertQueue('test', {}).then(done)
          }
        })
    })
    .catch(t.fail)
})
