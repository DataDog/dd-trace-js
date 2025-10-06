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

app.route(/^\/ab(cd)?$/)
  .patch((_, res) => res.send('ok'))

app.route(['/array-route-one', ['/array-route-two']])
  .post((_, res) => res.send('ok'))

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

// Multiple routers without mount path
const apiRouter1 = express.Router()
const apiRouter2 = express.Router()

apiRouter1.put('/router1', (_, res) => res.send('ok 1'))
apiRouter2.put('/router2', (_, res) => res.send('ok 2'))

app.use(apiRouter1, apiRouter2)

// Test nested routers before app.use
const router1 = express.Router()
const router2 = express.Router()
const router3 = express.Router()

router2.use('/path2', router3)
router3.get('/endpoint', (_, res) => res.send('ok'))
router1.use('/path', router2)

// Array mount path
const arrayMountRouter = express.Router()
arrayMountRouter.get('/', (_, res) => res.send('ok'))
arrayMountRouter.get('/mounted', (_, res) => res.send('ok'))

app.use(['/multi-array', '/multi-array-alt'], arrayMountRouter)

// Regex mount path
const regexMountRouter = express.Router()
regexMountRouter.get('/mounted', (_, res) => res.send('ok'))

app.use(/^\/regex-mount(?:\/|$)/, regexMountRouter)

// Add endpoint during runtime
setTimeout(() => {
  app.use('/root', router1)

  // Deeply nested routes
  const deepRouter = express.Router()
  deepRouter.get('/nested', (_, res) => res.send('ok'))
  const subRouter = express.Router()
  subRouter.get('/deep', (_, res) => res.send('ok'))
  subRouter.post('/deep/:id', (_, res) => res.send('ok'))
  deepRouter.use('/sub', subRouter)
  const arrayRouter = express.Router()
  arrayRouter.post(['/array-one', '/array-two'], (_, res) => res.send('ok'))
  deepRouter.use('/array', arrayRouter)
  const regexRouter = express.Router()
  regexRouter.put(/^\/item\/(\d+)$/, (_, res) => res.send('ok'))
  deepRouter.use('/regex', regexRouter)
  app.use('/api', deepRouter)
  app.get('/later', (_, res) => res.send('ok'))
}, 1_000)

// Same router mounted at multiple paths - should report both
const sharedRouter = express.Router()
sharedRouter.get('/shared-before', (_, res) => res.send('ok'))

app.use('/api/v1', sharedRouter)
app.use('/api/v2', sharedRouter)

sharedRouter.get('/shared-after', (_, res) => res.send('ok'))

// Cycle routers - should not be collected
const cycleRouter = express.Router()
cycleRouter.use('/cycle', cycleRouter)
app.use('/cycle', cycleRouter)

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  process.send({ port })
})
