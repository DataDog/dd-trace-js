'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('mysql')

const test = require('tape')
const mysql = require('../../../versions/mysql').get()
const profile = require('../../dd-trace/test/profile')

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
