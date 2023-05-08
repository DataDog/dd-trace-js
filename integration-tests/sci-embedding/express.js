const tracer = require('dd-trace')
const express = require('express')

tracer.init({ port: process.env.AGENT_PORT })

const app = express()

app.use((req, res) => {
  res.end('hello, world\n')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
