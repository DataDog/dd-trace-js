import 'dd-trace/init.js'
import express from 'express'
import knex from 'knex'
import dc from 'dc-polyfill'

const startRawQueryCh = dc.channel('datadog:knex:raw:start')
let counter = 0
startRawQueryCh.subscribe(() => {
  counter += 1
})

const app = express()

const db = knex({ client: 'pg' })

app.get('/', (req, res) => {
  db.raw('select 1')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
