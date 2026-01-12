import 'dd-trace/init.js'
import express from 'express'
import cookie from 'cookie'
import dc from 'dc-polyfill'

const cookieParseCh = dc.channel('datadog:cookie:parse:finish')
let counter = 0
cookieParseCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  cookie.parse('hello=world')
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
