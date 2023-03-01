'use strict'

const { PORT, REQUESTS, WITH_INTERNAL_TRACER, WITH_TRACER } = process.env

if (WITH_TRACER === 'true') {
  const tracer = require('../../..')
  tracer.init({
    startupLogs: false,
    plugins: false
  })
  tracer.use('http', { enabled: true })
  tracer.use('koa', { enabled: true, middleware: true })
}

if (WITH_INTERNAL_TRACER === 'true') {
  require('./internal-tracer')
}

const http = require('http')
const Koa = require('../../../versions/koa/node_modules/koa')
const net = require('net')
const app = new Koa()

const port = parseInt(PORT)
const requests = parseInt(REQUESTS)

let readyServer
let total = 0

app.use(async ctx => {
  ctx.body = 'OK'

  if (++total === requests) {
    server.close()
    readyServer.close()
  }

  await new Promise((resolve) => {
    setTimeout(resolve(), 500)
  })
})

const server = http.createServer(app.callback())

server.listen(port, () => {
  readyServer = net.createServer(() => {})
  readyServer.listen(port + 1)
})
