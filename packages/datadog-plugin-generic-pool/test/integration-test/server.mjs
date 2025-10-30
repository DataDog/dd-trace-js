import 'dd-trace/init.js'
import express from 'express'
import genericPool from 'generic-pool'
import { AsyncLocalStorage } from 'async_hooks'

const asyncStore = new AsyncLocalStorage()
const app = express()

const pool = new genericPool.Pool({
  create (cb) {
    setImmediate(() => {
      cb(null, {})
    })
  },
  destroy () {}
})

let counter = 0
app.get('/', (req, res) => {
  const store = 'test-store-value'

  asyncStore.run(store, () => {
    pool.acquire((err, resource) => {
      if (asyncStore.getStore() === store) {
        counter += 1
      }
      if (!err && resource) {
        pool.release(resource)
      }

      res.setHeader('X-Counter', counter)
      res.end('ok')
    })
  })
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
