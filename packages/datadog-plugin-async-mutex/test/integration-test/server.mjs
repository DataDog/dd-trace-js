import 'dd-trace/init.js'
import { Mutex } from 'async-mutex'
import express from 'express'
import dc from 'dc-polyfill'

const acquireStartCh = dc.channel('tracing:orchestrion:async-mutex:Semaphore_acquire:start')
let counter = 0
acquireStartCh.subscribe(() => {
  counter += 1
})

const mutex = new Mutex()

const app = express()

app.get('/', async (req, res) => {
  const release = await mutex.acquire()
  const queued = mutex.acquire()
  release()
  ;(await queued)()

  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
