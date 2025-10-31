import 'dd-trace/init.js'
import express from 'express'
import cookieParser from 'cookie-parser'
import dc from 'dc-polyfill'
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
  const port = server.address().port
  process.send({ port })
})
