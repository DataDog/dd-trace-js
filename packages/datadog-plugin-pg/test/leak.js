'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('pg')

const test = require('tape')
const pg = require('../../../versions/pg').get()
const profile = require('../../dd-trace/test/profile')

test('pg plugin should not leak', t => {
  const client = new pg.Client({
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    application_name: 'test'
  })

  client.connect(err => {
    if (err) return t.fail(err)

    profile(t, operation).then(() => client.end())
  })

  function operation (done) {
    client.query('SELECT 1 + 1 AS solution', done)
  }
})
