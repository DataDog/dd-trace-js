'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('memcached')

const test = require('tape')
const Memcached = require('../../../versions/memcached').get()
const profile = require('../../dd-trace/test/profile')

test('memcached plugin should not leak', t => {
  const memcached = new Memcached('localhost:11211', { retries: 0 })

  profile(t, operation).then(() => memcached.end())

  function operation (done) {
    memcached.get('foo', done)
  }
})
