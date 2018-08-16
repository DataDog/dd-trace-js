'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('mysql')

const test = require('tape')
const mysql = require('mysql')
const profile = require('../../profile')

test('mysql plugin should not leak', t => {
  const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    database: 'db'
  })

  connection.connect(err => {
    if (err) return t.fail(err)

    profile(t, operation).then(() => connection.end())
  })

  function operation (done) {
    connection.query('SELECT 1 + 1 AS solution', done)
  }
})
