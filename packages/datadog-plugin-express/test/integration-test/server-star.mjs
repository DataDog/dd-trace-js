import 'dd-trace/init.js'
import * as modexpress from 'express'
const express = modexpress.default

const app = express()

app.use((req, res) => {
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})

