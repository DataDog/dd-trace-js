import 'dd-trace/init.js'
import dc from 'node:diagnostics_channel'
import express from 'express'
import expressMongoSanitize from 'express-mongo-sanitize'
const app = express()

const sanitizeMiddlewareFinished = dc.channel('datadog:express-mongo-sanitize:filter:finish')

let counter = 0

sanitizeMiddlewareFinished.subscribe(() => {
  counter += 1
})

app.use(expressMongoSanitize())
app.all('/', (req, res) => {
  res.setHeader('X-Counter', counter)
  res.end()
})

const server = app.listen(0, () => {
  const port = (/** @type {import('net').AddressInfo} */ (server.address())).port
  process.send({ port })
})
