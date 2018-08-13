'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('pg')

const test = require('tape')
const pg = require('pg')
const profile = require('../../profile')

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
