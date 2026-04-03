import 'dd-trace/init.js'
import express from 'express'
import Handlebars from 'handlebars'
import dc from 'dc-polyfill'

const handlebarsCompileCh = dc.channel('datadog:handlebars:compile:start')
let counter = 0
handlebarsCompileCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  Handlebars.compile('Hello wrold!')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
