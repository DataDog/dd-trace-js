#!/usr/bin/env node
'use strict'

require('../../').init() // dd-trace
const assert = require('assert')
const express = require('express')
const redis = require('redis')
const app = express()
const PORT = 3000
const pg = require('pg')
const pgp = require('pg-promise')() // transient dep of 'pg'

assert.equal(redis.Graph.name, 'Graph')
assert.equal(pg.types.builtins.BOOL, 16)
assert.equal(express.static.mime.types.ogg, 'audio/ogg')

const conn = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'hunter2',
  port: 5433
}

console.log('pg connect') // eslint-disable-line no-console
const client = new pg.Client(conn)
client.connect()

console.log('pg-promise connect') // eslint-disable-line no-console
const client2 = pgp(conn)

app.get('/', async (_req, res) => {
  const query = await client.query('SELECT NOW() AS now')
  const query2 = await client2.query('SELECT NOW() AS now')
  res.json({
    connection_pg: query.rows[0].now,
    connection_pg_promise: query2[0].now
  })
})

app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`) // eslint-disable-line no-console
})
