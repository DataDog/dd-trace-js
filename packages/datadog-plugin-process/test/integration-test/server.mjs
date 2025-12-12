import 'dd-trace/init.js'
import express from 'express'
import process from 'node:process'
import dc from 'dc-polyfill'

const startCh = dc.channel('datadog:process:setUncaughtExceptionCaptureCallback:start')
let counter = 0
startCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  process.setUncaughtExceptionCaptureCallback(() => {})
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
