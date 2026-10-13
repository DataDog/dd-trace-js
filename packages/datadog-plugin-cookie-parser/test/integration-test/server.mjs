import 'dd-trace/init.js'
import dc from 'node:diagnostics_channel'
import express from 'express'
import cookieParser from 'cookie-parser'
const cookieParserReadCh = dc.channel('datadog:cookie-parser:read:finish')
let counter = 0
cookieParserReadCh.subscribe(() => {
  counter += 1
})
const app = express()

app.use(cookieParser())
app.use((req, res) => {
  res.setHeader('X-Counter', counter)
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
