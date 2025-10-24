import 'dd-trace/init.js'
import express from 'express'
import expressSession from 'express-session'
import dc from 'dc-polyfill'

const sessionMiddlewareCh = dc.channel('datadog:express-session:middleware:finish')
let counter = 0
sessionMiddlewareCh.subscribe(() => {
  counter += 1
})

const app = express()

app.use(expressSession({
  secret: 'secret',
  resave: false,
  rolling: true,
  saveUninitialized: true,
  genid: () => 'sid_123'
}))

app.get('/', (req, res) => {
  process._rawDebug('Hellow')
  res.setHeader('X-Counter', counter)
  res.send('OK')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
