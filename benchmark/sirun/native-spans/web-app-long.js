'use strict'
const http = require('http')
const tracer = require('../../..').init({
  hostname: '127.0.0.1', port: 0, flushInterval: 0, plugins: false,
})
tracer.use('http'); tracer.use('express')
const express = require('express')
const REQUESTS = 50000
const CONCURRENCY = 20
const app = express()
app.use((req, res, next) => { const s = tracer.scope().active(); if (s) { s.setTag('auth.user', 'bench'); s.setTag('auth.method', 'token') }; next() })
app.use((req, res, next) => { const s = tracer.scope().active(); if (s) { s.setTag('request.id', 'r-' + Math.random().toString(36).slice(2, 10)) }; next() })
app.get('/api/users/:id', (req, res) => {
  const span = tracer.startSpan('db.query', { childOf: tracer.scope().active(), tags: { 'service.name': 'pg', 'resource.name': 'SELECT', 'span.type': 'sql', 'db.type': 'pg', 'db.name': 'myapp', 'db.user': 'appuser', 'db.instance': 'primary' } })
  setTimeout(() => { span.setTag('db.row_count', 1); span.finish(); res.json({ id: req.params.id }) }, 1)
})
app.get('/api/orders/:id', (req, res) => {
  const span1 = tracer.startSpan('cache.get', { childOf: tracer.scope().active(), tags: { 'service.name': 'redis', 'resource.name': 'GET', 'span.type': 'cache', 'cache.backend': 'redis' } })
  setTimeout(() => {
    span1.setTag('cache.hit', false); span1.finish()
    const span2 = tracer.startSpan('db.query', { childOf: tracer.scope().active(), tags: { 'service.name': 'pg', 'resource.name': 'SELECT orders', 'span.type': 'sql', 'db.type': 'pg' } })
    setTimeout(() => { span2.setTag('db.row_count', 3); span2.finish(); res.json({ id: req.params.id, items: 3 }) }, 1)
  }, 0)
})
app.get('/api/health', (req, res) => res.json({ ok: true }))
const server = app.listen(0, () => {
  const port = server.address().port; let completed = 0; let inFlight = 0
  const start = process.hrtime.bigint()
  function sendRequest () {
    if (completed >= REQUESTS) return; if (inFlight >= CONCURRENCY) return
    inFlight++
    const r = completed % 10
    const path = r < 1 ? '/api/health' : r < 6 ? '/api/users/' + (completed % 100 + 1) : '/api/orders/' + (completed % 50 + 1)
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      res.resume(); res.on('end', () => {
        inFlight--; completed++
        if (completed >= REQUESTS) {
          const ms = Number(process.hrtime.bigint() - start) / 1e6
          // eslint-disable-next-line no-console
          console.log(REQUESTS + ' requests in ' + ms.toFixed(0) + 'ms (' + (REQUESTS / ms * 1000).toFixed(0) + ' req/s)')
          server.close(); setTimeout(() => process.exit(), 500); return
        }
        sendRequest()
      })
    }).on('error', () => { inFlight--; completed++; sendRequest() })
    sendRequest()
  }
  for (let i = 0; i < CONCURRENCY; i++) sendRequest()
})
