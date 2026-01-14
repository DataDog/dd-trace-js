import 'dd-trace/init.js'
import { createHash } from 'node:crypto'
import express from 'express'
import dc from 'dc-polyfill'

const cryptoHashCh = dc.channel('datadog:crypto:hashing:start')
let counter = 0
cryptoHashCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  createHash('sha256')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
