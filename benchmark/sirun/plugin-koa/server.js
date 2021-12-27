'use strict'

const { PORT, REQUESTS, WITH_INTERNAL_TRACER, WITH_TRACER } = process.env

if (WITH_TRACER === 'true') {
  require('../../..').init({
    startupLogs: false
  })
}

if (WITH_INTERNAL_TRACER === 'true') {
  require('./internal-tracer')
}

const http = require('http')
const Koa = require('koa')
const net = require('net')
const app = new Koa()

const port = parseInt(PORT)
const requests = parseInt(REQUESTS)

let readyServer
let total = 0

app.use(ctx => {
  ctx.body = 'OK'

  if (++total === requests) {
    server.close()
    readyServer.close()
  }
})

const server = http.createServer(app.callback())

server.listen(port, () => {
  readyServer = net.createServer(() => {})
  readyServer.listen(port + 1)
})
