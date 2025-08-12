'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')
const app = express()

// Basic routes
app.get('/users', (_, res) => res.send('ok'))
app.post('/users', (_, res) => res.send('ok'))
app.put('/users/:id', (_, res) => res.send('ok'))
app.delete('/users/:id', (_, res) => res.send('ok'))
app.patch('/users/:id', (_, res) => res.send('ok'))
app.options('/users', (_, res) => res.send('ok'))

// Additional methods
app.trace('/trace-test', (_, res) => res.send('ok'))
app.head('/head-test', (_, res) => res.send('ok'))
app.connect('/connect-test', (_, res) => res.send('ok'))

// Using app.route()
app.route('/multi-method')
  .post((_, res) => res.send('ok'))
  .all((_, res) => res.send('ok'))

// Wildcard route
app.all('/wildcard', (_, res) => res.send('ok'))

// Nested routes with Router
const apiRouter = express.Router()
apiRouter.put('/nested/:id', (_, res) => res.send('ok'))
apiRouter.all('/nested', (_, res) => res.send('ok'))
app.use('/v1', apiRouter)

// Add endpoint during runtime
setTimeout(() => {
  // Deeply nested routes
  const deepRouter = express.Router()
  const subRouter = express.Router()
  subRouter.get('/deep', (_, res) => res.send('ok'))
  subRouter.post('/deep/:id', (_, res) => res.send('ok'))
  deepRouter.use('/sub', subRouter)
  app.use('/api', deepRouter)
}, 1_000)

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.send({ port })
})
