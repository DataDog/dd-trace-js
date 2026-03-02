import 'dd-trace/init.js'
import { AsyncLocalStorage } from 'async_hooks'
import express from 'express'
import knex from 'knex'

let counter = 0
const asyncStore = new AsyncLocalStorage()
const app = express()

const db = knex({
  client: 'sqlite3',
  connection: { filename: ':memory:' },
})

app.get('/', (req, res) => {
  const store = 'knex-test-store'

  asyncStore.run(store, () => {
    db.raw('PRAGMA user_version')
      .then(() => {
        if (asyncStore.getStore() === store) {
          counter += 1
        }
        res.setHeader('X-Counter', counter)
        res.end('ok')
      })
      .catch(() => {})
  })
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
