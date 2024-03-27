'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('mongodb-core')

const test = require('tape')
const mongo = require('../../../versions/mongodb-core').get()
const profile = require('../../dd-trace/test/profile')

test('mongodb-core plugin should not leak', t => {
  const server = new mongo.Server({
    host: 'localhost',
    port: 27017,
    reconnect: false
  })

  server.on('connect', () => {
    profile(t, operation).then(() => server.destroy())
  })

  server.on('error', t.fail)

  server.connect()

  function operation (done) {
    server.insert('test.1234', [{ a: 1 }], {}, done)
  }
})
