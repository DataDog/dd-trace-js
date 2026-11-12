'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { setImmediate } = require('node:timers/promises')

const proxyquire = require('proxyquire')

assert.equal(typeof global.gc, 'function')

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

/** @param {import('../../../../index').Span} span */
function cacheRef (span) {
  const key = Object.getOwnPropertySymbols(span).find(symbol => symbol.description === 'OtelThreadCtx.cached')
  assert.ok(key)
  return new WeakRef(span[key])
}

/** @param {boolean} resolved */
function startRequest (resolved) {
  return tracer.startSpan('request', {
    tags: { 'span.type': 'web', 'http.method': 'GET', 'resource.name': resolved ? 'GET /stream' : 'GET' },
  })
}

async function main () {
  if (process.argv[2] === 'refinement') return checkRouteRefinements()
  const resolved = process.argv[2].endsWith('-resolved')
  if (process.argv[2].startsWith('late')) return checkReactivatedSpans(resolved)
  if (process.argv[2].startsWith('retained')) return checkRetainedCallbacks(resolved)
  const root = startRequest(resolved)
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
  global.gc?.()
  assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0, process.argv[2])
  // Keep the unresolved request alive across collection.
  root.setTag('http.route', '/stream')
  root.finish()
}

/** @param {boolean} resolved */
async function checkReactivatedSpans (resolved) {
  const root = process.argv[2] === 'late-no-web' || process.argv[2] === 'late-promoted'
    ? tracer.startSpan('request')
    : startRequest(resolved)
  const refs = []
  const scope = tracer.scope()
  scope.activate(root, () => {
    for (let i = 0; i < 32; i++) {
      const child = tracer.startSpan('child', {
        childOf: root,
        tags: process.argv[2] === 'late-own' ? { 'span.type': 'web', 'http.method': 'GET' } : undefined,
      })
      if (i % 2) scope.activate(child, () => {})
      const callback = scope.bind(() => {
        refs.push(cacheRef(child))
        return current
      }, child)
      child.finish()
      const context = callback()
      if (i === 0 && process.argv[2] === 'late-promoted') {
        assert.equal(context.attributes[1], undefined)
        root.addTags({ 'span.type': 'web', 'http.method': 'GET', 'resource.name': 'GET /promoted' })
        assert.equal(context.attributes[1], 'GET /promoted')
      }
    }
  })
  await collectReleasedRecords(refs)
  assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0)
  root.setTag('resource.name', 'GET /refined')
  root.finish()
}

/** @param {boolean} resolved */
async function checkRetainedCallbacks (resolved) {
  const root = startRequest(resolved)
  const scope = tracer.scope()
  const live = []
  scope.activate(root, () => {
    for (let i = 0; i < 64; i++) {
      const child = tracer.startSpan('live', { childOf: root })
      scope.activate(child, () => {})
      live.push(child)
    }
  })
  for (let batch = 0; batch < 4; batch++) {
    const refs = []
    scope.activate(root, () => {
      for (let i = 0; i < 128; i++) {
        const child = tracer.startSpan('late', { childOf: root })
        child.finish()
        const callback = scope.bind(() => { refs.push(cacheRef(child)) }, child)
        callback()
      }
    })
    await collectReleasedRecords(refs)
    assert.equal(refs.filter(ref => ref.deref() !== undefined).length, 0)
    if (batch === 0) {
      live[0].finish()
      live[2].finish()
    }
  }
  const retained = []
  scope.activate(root, () => {
    for (let i = 0; i < 4; i++) {
      const child = tracer.startSpan('retained', { childOf: root })
      child.finish()
      const callback = scope.bind(() => current, child)
      const context = callback()
      assert.ok(context)
      retained.push({ child, callback, context })
    }
  })
  live[1].finish()
  live[3].finish()
  await setImmediate()
  global.gc?.()
  root.setTag('resource.name', 'GET /refined')
  for (const entry of retained) assert.equal(entry.context.attributes[1], 'GET /refined')
  retained[3].child.addTags({ 'span.type': 'web', 'http.method': 'GET', 'resource.name': 'GET /own' })
  root.setTag('resource.name', 'GET /outer')
  assert.equal(retained[3].context.attributes[1], 'GET /own')
  for (const entry of retained.slice(0, 3)) assert.equal(entry.context.attributes[1], 'GET /outer')

  const parent = tracer.startSpan('parent', { childOf: root, tags: { 'http.method': 'GET' } })
  const child = tracer.startSpan('retargeted', { childOf: parent })
  child.finish()
  const callback = scope.bind(() => current, child)
  const context = callback()
  assert.ok(context)
  parent.addTags({ 'span.type': 'web', 'resource.name': 'GET /nearer' })
  assert.equal(context.attributes[1], 'GET /nearer')
  root.setTag('resource.name', 'GET /outer/refined')
  assert.equal(context.attributes[1], 'GET /nearer')
  assert.equal(callback(), context)
  parent.finish()
  for (const child of live) child.finish()
  root.finish()
}

/** @param {Array<WeakRef<object>>} refs */
async function collectReleasedRecords (refs) {
  // Finalizer cleanup has no fixed GC-cycle deadline. Use the same bound as Node's gcUntil helper.
  for (let cycle = 0; cycle < 10; cycle++) {
    await setImmediate()
    await global.gc({ execution: 'async', flavor: 'last-resort' })
    if (refs.every(ref => ref.deref() === undefined)) return
  }
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
