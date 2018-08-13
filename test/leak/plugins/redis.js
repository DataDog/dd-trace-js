'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('redis')

const test = require('tape')
const redis = require('redis')
const profile = require('../../profile')

test('redis plugin should not leak', t => {
  const client = redis.createClient()

  profile(t, operation).then(() => client.quit())

  function operation (done) {
    client.get('foo', done)
  }
})
