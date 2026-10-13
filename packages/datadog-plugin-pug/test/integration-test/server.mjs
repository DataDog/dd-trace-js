import 'dd-trace/init.js'
import dc from 'node:diagnostics_channel'
import express from 'express'
import pug from 'pug'

const pugCompileCh = dc.channel('datadog:pug:compile:start')
let counter = 0
pugCompileCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  pug.compile('Hello World')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
