import 'dd-trace/init.js'
import express from 'express'
import expressMongoSanitize from 'express-mongo-sanitize'
import dc from 'dc-polyfill'
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
  const port = server.address().port
  process.send({ port })
})
