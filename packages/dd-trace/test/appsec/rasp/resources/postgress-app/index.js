'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')
const pg = require('pg')

const connectionData = {
  host: '127.0.0.1',
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  application_name: 'test'
}

const pool = new pg.Pool(connectionData)

const app = express()

app.get('/sqli/client/uncaught-promise', async (req, res) => {
  const client = new pg.Client(connectionData)
  await client.connect()

  try {
    await client.query(`SELECT * FROM users WHERE id = '${req.query.param}'`)
  } finally {
    client.end()
  }

  res.end('OK')
})

app.get('/sqli/client/uncaught-query-error', async (req, res) => {
  const client = new pg.Client(connectionData)
  await client.connect()
  const query = new pg.Query(`SELECT * FROM users WHERE id = '${req.query.param}'`)
  client.query(query)

  query.on('end', () => {
    res.end('OK')
  })
})

app.get('/sqli/pool/uncaught-promise', async (req, res) => {
  await pool.query(`SELECT * FROM users WHERE id = '${req.query.param}'`)
  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
