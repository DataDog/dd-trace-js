'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('mysql2')

const test = require('tape')
const mysql2 = require('../../../versions/mysql2').get()
const profile = require('../../dd-trace/test/profile')

test('mysql2 plugin should not leak', t => {
  const connection = mysql2.createConnection({
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
