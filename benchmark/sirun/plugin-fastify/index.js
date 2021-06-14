'use strict'

const assert = require('assert')

function run (task) {
  const hasProfiler = process.env.PROFILER === 'true'
  const hasTracer = process.env.TRACER === 'true'

  if (!hasProfiler && !hasTracer) {
    return task()
  }

  process.env.DD_EXPERIMENTAL_PROFILING_ENABLED = hasProfiler
  process.env.DD_PROFILING_INTERVAL = '1000'

  require('../../..').init({
    url: 'http://localhost:8126',
    profiling: hasProfiler,
    enabled: hasTracer
  })

  let expectedRequests = (hasProfiler && hasTracer) ? 2 : 1

  const http = require('http')

  const server = http.createServer((req, res) => {
    req.resume()
    res.end()

    if (hasProfiler && req.url === '/profiling/v1/input') {
      expectedRequests--
    } else if (hasTracer && /\/traces$/.test(req.url)) {
      expectedRequests--
    }

    if (expectedRequests < 1) {
      server.close()
    }
  })

  server.listen(8126, task)
}

run(async () => {
  const app = require('../../../versions/fastify/node_modules/fastify')()

  app.get('/', (request, reply) => {
    return { hello: 'world' }
  })

  try {
    await app.listen(3000)

    const { statusCode, body } = await app.inject({
      method: 'GET',
      url: '/'
    })

    assert.strictEqual(statusCode, 200)
    assert.strictEqual(body, '{"hello":"world"}')

    await app.close()
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
})
