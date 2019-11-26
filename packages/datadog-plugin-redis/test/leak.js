'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('redis')

const test = require('tape')
const redis = require('../../../versions/redis').get()
const profile = require('../../dd-trace/test/profile')

test('redis plugin should not leak', t => {
  const client = redis.createClient(16379)

  profile(t, operation).then(() => client.quit())

  function operation (done) {
    client.get('foo', done)
  }
})
