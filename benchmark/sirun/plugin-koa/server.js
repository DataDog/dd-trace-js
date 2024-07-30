'use strict'

const {
  PORT,
  REQUESTS,
  WITH_ASYNC_HOOKS,
  WITH_COLUMNAR_TRACER,
  WITH_FAKE_DB,
  WITH_INTERNAL_TRACER,
  WITH_TRACER
} = process.env

let tracer
let encoder
let storage
let TraceContext

if (WITH_TRACER === 'true') {
  tracer = require('../../..')
  tracer.init({
    startupLogs: false,
    plugins: false
  })
  tracer.use('http', { enabled: true })
  tracer.use('koa', { enabled: true, middleware: true })
}

if (WITH_ASYNC_HOOKS === true) {
  require('async_hooks').createHook({
    init () {},
    before () {},
    after () {},
    promiseResolve () {}
  }).enable()
}

if (WITH_INTERNAL_TRACER === 'true') {
  require('./internal-tracer')
  encoder = require('./internal-tracer/encoder').encoder
  storage = require('../../../packages/datadog-core').storage
  TraceContext = require('./internal-tracer/context').TraceContext
}

if (WITH_COLUMNAR_TRACER === 'true') {
  require('./columnar')
  encoder = require('./columnar/encoder').encoder
  storage = require('../../../packages/datadog-core').storage
  TraceContext = require('./columnar/context').TraceContext
}

const http = require('http')
const Koa = require('../../../versions/koa/node_modules/koa')
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

  if (WITH_FAKE_DB === 'true') {
    for (let i = 0; i < 25; i++) {
      const query = startQuery()

      if (WITH_TRACER) {
        const span = traceQuery(query)
        runQuery(query)
        span.finish()
      } else if (WITH_COLUMNAR_TRACER) {
        const traceContext = storage.getStore()
        encoder.encodeMysqlQueryStart(query, traceContext)
        runQuery(query)
        encoder.encodeFinish(traceContext)
      } else if (WITH_INTERNAL_TRACER) {
        const store = storage.getStore()
        const parent = store.traceContext
        store.traceContext = new TraceContext(parent)
        encoder.encodeMysqlQueryStart(query)
        runQuery(query)
        encoder.encodeFinish()
        store.traceContext = parent
      } else {
        runQuery(query)
      }
    }
  }
})

const server = http.createServer(app.callback())

server.listen(port, () => {
  readyServer = net.createServer(() => {})
  readyServer.listen(port + 1)
})

function startQuery () {
  return {
    sql: 'SELECT * FROM mytable WHERE 1 = 1;',
    conf: {
      user: 'myuser',
      database: 'mydatabase',
      host: '127.0.0.1',
      port: '3306'
    }
  }
}

function runQuery () {
  // return new Promise(resolve => {
  //   setTimeout(resolve, Math.random() * 5)
  // })
}

function traceQuery (query) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan('mysql.query', {
    childOf,
    tags: {
      'span.kind': 'client',
      'span.type': 'sql',
      'resource.name': query.sql,
      'db.type': 'mysql',
      'db.user': query.conf.user,
      'db.name': query.conf.database,
      'out.host': query.conf.host,
      'out.port': query.conf.port
    }
  })

  span.finish()

  return span
}
