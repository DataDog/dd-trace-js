'use strict'

const tracer = require('dd-trace')
tracer.init({
  flushInterval: 0
})

const express = require('express')
const app = express()

// Basic routes
app.get('/users', (_, res) => res.send('ok'))
app.post('/users/', (_, res) => res.send('ok'))
app.put('/users/:id', (_, res) => res.send('ok'))
app.delete('/users/:id', (_, res) => res.send('ok'))
app.patch('/users/:id/:name', (_, res) => res.send('ok'))
app.options('/users/:id', (_, res) => res.send('ok'))

// Additional methods
app.trace('/trace-test', (_, res) => res.send('ok'))
app.head('/head-test', (_, res) => res.send('ok'))
app.connect('/connect-test', (_, res) => res.send('ok'))

// Using app.route()
app.route('/multi-method')
  .post((_, res) => res.send('ok'))
  .put((_, res) => res.send('ok'))
  .patch((_, res) => res.send('ok'))
  .all((_, res) => res.send('ok'))

// All supported methods route
app.all('/all-methods', async (_, res) => res.send('ok'))

// Wildcard routes via array
app.all(['/wildcard/*name'], (_, res) => res.send('ok'))

// RegExp wildcard route
app.all(/^\/login\/.*$/i, (req, res) => {
  res.send('ok')
})

// Nested routes with Router
const apiRouter = express.Router()
app.use('/v1', apiRouter)
apiRouter.put('/nested/:id', (_, res) => res.send('ok'))

// Add endpoint during runtime
setTimeout(() => {
  // Deeply nested routes
  const deepRouter = express.Router()
  deepRouter.get('/nested', (_, res) => res.send('ok'))
  const subRouter = express.Router()
  subRouter.get('/deep', (_, res) => res.send('ok'))
  subRouter.post('/deep/:id', (_, res) => res.send('ok'))
  deepRouter.use('/sub', subRouter)
  app.use('/api', deepRouter)
  app.get('/later', (_, res) => res.send('ok'))
}, 1_000)

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.send({ port })
})
