'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { setImmediate } = require('node:timers/promises')

const proxyquire = require('proxyquire')

let current
class ThreadContext {
  /**
   * @param {Uint8Array} traceId
   * @param {Uint8Array} spanId
   * @param {number} traceFlags
   * @param {Array<string | undefined>} attributes
   */
  constructor (traceId, spanId, traceFlags, attributes) { this.attributes = attributes }
  enter () { current = this }
  invalidate () {}
  /** @param {Array<string | undefined>} attributes */
  appendAttributes (attributes) {
    for (let i = 0; i < attributes.length; i++) {
      if (attributes[i] !== undefined) this.attributes[i] = attributes[i]
    }
  }

  setTraceFlags () {}
}

const writer = proxyquire('../../src/otel-thread-ctx', {
  '../../datadog-core/src/storage': { isACFActive: true },
  '@datadog/pprof': {
    '@noCallThru': true,
    otelThreadCtx: {
      ThreadContext,
      getContext: () => current,
      clearContext: () => { current = undefined },
      getProcessContextAttributes: () => ({}),
    },
  },
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
assert.equal(writer.start(), true)
Object.defineProperty(process, 'platform', platform)

const tracer = require('../../../..').init({
  plugins: process.argv[2] === 'refinement',
  startupLogs: false,
  sampleRate: 0,
  flushMinSpans: 2,
  flushInterval: 0,
})

/** @param {import('../../src/opentracing/span')} span */
function cacheRef (span) {
  const key = Object.getOwnPropertySymbols(span).find(symbol => symbol.description === 'OtelThreadCtx.cached')
  assert.ok(key)
  return new WeakRef(span[key])
}

async function main () {
  if (process.argv[2] === 'refinement') return checkRouteRefinements()
  const resolved = process.argv[2].endsWith('-resolved')
  const root = tracer.startSpan('request', {
    tags: { 'span.type': 'web', 'http.method': 'GET', 'resource.name': resolved ? 'GET /stream' : 'GET' },
  })
  const refs = []
  tracer.scope().activate(root, () => {
    const parent = tracer.startSpan('parent', {
      childOf: root,
      tags: { 'http.method': 'GET', 'resource.name': 'GET' },
    })
    tracer.scope().activate(parent, () => {
      const children = []
      for (let i = 0; i < 32; i++) {
        const child = tracer.startSpan('child', { childOf: parent })
        tracer.scope().activate(child, () => { refs.push(cacheRef(child)) })
        children.push(child)
      }
      if (process.argv[2].startsWith('retarget')) {
        refs.push(cacheRef(parent))
        parent.setTag('span.type', 'web')
      }
      children[0].finish()
      children[31].finish()
      children[16].finish()
      for (const child of children) child.finish()
    })
    parent.finish()
  })
  await setImmediate()
  global.gc()
  assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0, process.argv[2])
  // Keep the unresolved request alive across collection.
  root.setTag('http.route', '/stream')
  root.finish()
}

async function checkRouteRefinements () {
  tracer.use('http', { client: false })
  tracer.use('express', { middleware: false })
  const http = require('node:http')
  const express = require('express')
  const app = express()
  const router = express.Router()
  let requestContext
  let childContext
  let handlerError
  router.use((req, res, next) => {
    tracer.trace('child', () => {
      childContext = current
      next()
    })
  })
  router.all('/users/:id', (req, res) => {
    const endpoint = `${req.method === 'GET' ? 'GET' : 'HTTP'} /api/users/:id`
    assert.equal(requestContext.attributes[1], endpoint)
    assert.equal(childContext.attributes[1], endpoint)
    res.end('ok')
  })
  app.use('/api', router)
  app.use((error, req, res, next) => {
    handlerError = error
    res.status(500).end()
  })
  const server = http.createServer((req, res) => {
    requestContext = current
    assert.equal(requestContext.attributes[1], undefined)
    app(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    for (const method of ['GET', 'PROPFIND']) {
      let status
      const request = http.request(`http://127.0.0.1:${server.address().port}/api/users/1`, { method }, response => {
        status = response.statusCode
        response.resume()
      })
      request.end()
      await once(request, 'close')
      if (handlerError) throw handlerError
      assert.equal(status, 200)
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
