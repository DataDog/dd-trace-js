'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const proxyquire = require('proxyquire')

let current
class ThreadContext {
  enter () { current = this }
  invalidate () {}
  appendAttributes () {}
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
  plugins: false,
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
  const root = tracer.startSpan('request', {
    tags: { 'span.type': 'web', 'http.method': 'GET', 'resource.name': 'GET' },
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
      if (process.argv[2] === 'retarget') {
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

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
