import 'dd-trace/init.js'
import express from 'express'
import { URL } from 'node:url'
import dc from 'dc-polyfill'

const parseFinishChannel = dc.channel('datadog:url:parse:finish')
let counter = 0
parseFinishChannel.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  const urlString = req.query.url || 'https://example.com:8080/path?query=value'
  const url = new URL(urlString)
  res.setHeader('X-Counter', counter)
  res.send(`URL parsed successfully ${url}`)
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
