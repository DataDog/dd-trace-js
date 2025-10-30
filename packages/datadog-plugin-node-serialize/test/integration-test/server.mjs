import 'dd-trace/init.js'
import express from 'express'
import dc from 'dc-polyfill'
import lib from 'node-serialize'

const nodeUnserializeCh = dc.channel('datadog:node-serialize:unserialize:start')

let counter = 0
nodeUnserializeCh.subscribe(() => {
  counter += 1
})

const app = express()

app.get('/', (req, res) => {
  const serialized = lib.serialize({ hello: 'world' })
  lib.unserialize(serialized)
  res.setHeader('X-Counter', counter)
  res.end('ok')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
