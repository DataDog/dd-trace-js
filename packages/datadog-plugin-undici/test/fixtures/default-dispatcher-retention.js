'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const { promisify } = require('node:util')

const { channel } = require('dc-polyfill')

const gc = global.gc
if (typeof gc !== 'function') {
  throw new Error('default-dispatcher-retention.js requires --expose-gc')
}

const REQUEST_COUNT = 32
const RETAINED_SPAN_LIMIT = 10
const finishedSpans = []
const requestSpanIds = new Set()
const tcpParentIds = []
let fetchSpanCount = 0
let undiciSpanCount = 0

channel('dd-trace:span:finish').subscribe(span => {
  const component = span.context().getTag('component')
  if (component === 'fetch') {
    fetchSpanCount++
  } else if (component === 'undici') {
    undiciSpanCount++
    finishedSpans.push(new WeakRef(span))
    requestSpanIds.add(span.context()._spanId.toString(10))
  } else if (span._name === 'tcp.connect') {
    const parentId = span.context()._parentId
    if (parentId) {
      tcpParentIds.push(parentId.toString(10))
    }
  }
})

const tracer = require('../../../..').init({
  flushInterval: 0,
  plugins: false,
  startupLogs: false,
})
tracer.use('fetch', true)
tracer.use('net', true)
if (process.env.UNDICI_PLUGIN_DISABLED !== 'true') {
  tracer.use('undici', true)
}

const dispatcherSymbol = globalThis[Symbol.for('undici.globalDispatcher.2')]
  ? Symbol.for('undici.globalDispatcher.2')
  : Symbol.for('undici.globalDispatcher.1')
assert.ok(globalThis[dispatcherSymbol])
const originalGlobalDispatcher = globalThis[dispatcherSymbol]
let throwingDispatchReads = 0

if (process.env.FROZEN_GLOBAL_DISPATCHER === 'true') {
  globalThis[dispatcherSymbol] = Object.freeze({
    close: originalGlobalDispatcher.close.bind(originalGlobalDispatcher),
    dispatch: originalGlobalDispatcher.dispatch.bind(originalGlobalDispatcher),
  })
} else if (process.env.THROWING_GLOBAL_DISPATCHER === 'true') {
  globalThis[dispatcherSymbol] = new Proxy({}, {
    get (_target, property) {
      if (property === 'dispatch') {
        throwingDispatchReads++
        throw new Error('dispatch is not readable')
      }
      return originalGlobalDispatcher[property]
    },
  })
}

const undici = require('../../../../versions/undici').get()
if (process.env.THROWING_GLOBAL_DISPATCHER === 'true') {
  assert.strictEqual(throwingDispatchReads, 1)
  globalThis[dispatcherSymbol] = originalGlobalDispatcher
}
if (process.env.FOREIGN_GLOBAL_DISPATCHER === 'true') {
  const dispatcher = undici.getGlobalDispatcher()
  const foreignDispatcher = Object.create(dispatcher)
  foreignDispatcher.close = dispatcher.close.bind(dispatcher)
  foreignDispatcher.dispatch = dispatcher.dispatch.bind(dispatcher)
  undici.setGlobalDispatcher(foreignDispatcher)
}
const server = http.createServer((_request, response) => response.end('ok'))

/**
 * @param {string} url
 */
async function requestAndConsume (url) {
  const { body } = await undici.request(url)
  await body.text()
}

async function main () {
  if (process.env.THROWING_GLOBAL_DISPATCHER === 'true') return

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (/** @type {import('node:net').AddressInfo} */ (server.address())).port
  const url = `http://127.0.0.1:${port}/`

  if (process.env.FROZEN_GLOBAL_DISPATCHER === 'true') {
    const parent = tracer.startSpan('parent')
    await tracer.scope().activate(parent, () => requestAndConsume(url))
    parent.finish()
  } else {
    await requestAndConsume(url)
  }

  const globalResponse = await globalThis.fetch(url)
  await globalResponse.arrayBuffer()

  for (let requestIndex = 0; requestIndex < REQUEST_COUNT; requestIndex++) {
    await requestAndConsume(url)
    assert.strictEqual(tracer.scope().active(), null)
  }

  await Promise.all([
    undici.getGlobalDispatcher().close(),
    promisify(server.close.bind(server))(),
  ])

  assert.strictEqual(fetchSpanCount, 1)
  const expectedUndiciSpanCount = process.env.UNDICI_PLUGIN_DISABLED === 'true' ? 0 : REQUEST_COUNT + 1
  assert.strictEqual(undiciSpanCount, expectedUndiciSpanCount)
  if (process.env.FROZEN_GLOBAL_DISPATCHER !== 'true' && process.env.UNDICI_PLUGIN_DISABLED !== 'true') {
    assert.ok(tcpParentIds.some(parentId => requestSpanIds.has(parentId)))
  }

  for (let cycle = 0; cycle < 10; cycle++) {
    gc?.()
    await new Promise(resolve => setImmediate(resolve))
  }

  let retainedSpanCount = 0
  for (const spanReference of finishedSpans) {
    if (spanReference.deref()) retainedSpanCount++
  }
  assert.ok(
    retainedSpanCount <= RETAINED_SPAN_LIMIT,
    `${retainedSpanCount} of ${finishedSpans.length} finished Undici spans remain reachable`
  )
}

main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`${error.stack || error}\n`)
})
