import 'dd-trace/init.js'
import express from 'express'
import bodyParser from 'body-parser'
import dc from 'dc-polyfill'
const bodyParserReadCh = dc.channel('datadog:body-parser:read:finish')
let counter = 0
bodyParserReadCh.subscribe(() => {
  counter += 1
})
const app = express()

app.use(bodyParser.json())
app.post('/', (req, res) => {
  res.setHeader('X-Counter', counter)
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
