'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('amqplib')

const test = require('tape')
const profile = require('../../dd-trace/test/profile')

test('amqplib plugin should not leak when using callbacks', t => {
  require('../../../versions/amqplib').get('amqplib/callback_api')
    .connect((err, conn) => {
      if (err) return t.fail(err)

      conn.createChannel((err, ch) => {
        if (err) return t.fail(err)

        profile(t, operation, 400).then(() => conn.close())

        function operation (done) {
          ch.assertQueue('test', {}, done)
        }
      })
    })
})

test('amqplib plugin should not leak when using promises', t => {
  require('../../../versions/amqplib').get().connect()
    .then(conn => {
      return conn.createChannel()
        .then(ch => {
          profile(t, operation, 400).then(() => conn.close())

          function operation (done) {
            ch.assertQueue('test', {}).then(done)
          }
        })
    })
    .catch(t.fail)
})
