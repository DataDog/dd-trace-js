'use strict'

// Microbenchmarks that isolate the graphql plugin's hot-path functions.
// Run: node benchmark/sirun/plugin-graphql-long/microbench.js
//
// Each bench runs the target N times inside a tight loop and reports
// nanoseconds-per-op. Targets the exact call shapes produced by the
// plugin's runtime path so regressions can be pinpointed by function.
//
// Usage:
//   node microbench.js              # run all
//   node microbench.js wrapResolve  # run one

/* eslint-disable no-console */

const { performance } = require('node:perf_hooks')
const dc = require('dc-polyfill')

// PURE=1  → no tracer at all (pure graphql baseline)
// NOSUB=1 → tracer loaded (orchestrion rewrites graphql) but graphql plugin
//           disabled, so all per-field channel publishes have zero subscribers
// default → full tracer + graphql plugin active (what the sirun bench measures)
const PURE = process.env.PURE === '1'
const NOSUB = process.env.NOSUB === '1'

if (!PURE) {
  require('../../..').init()
}

// dd-trace must be initialized before requiring plugin internals (if applicable).
const graphql = require('../../../versions/graphql').get()
const schema = require('./schema')

// Tracer needs to be using the graphql plugin so the channels have subscribers
// that mirror the real runtime.
if (!PURE && !NOSUB) {
  require('../../..').use('graphql')
}

/** @type {Array<{ name: string, ops: number, ns: number }>} */
const results = []

function bench (name, ops, fn) {
  // Warmup
  for (let i = 0; i < Math.min(1000, ops); i++) fn()

  const iters = 5
  let minNs = Infinity
  for (let r = 0; r < iters; r++) {
    const t0 = performance.now()
    for (let i = 0; i < ops; i++) fn()
    const t1 = performance.now()
    const ns = ((t1 - t0) * 1e6) / ops
    if (ns < minNs) minNs = ns
  }

  results.push({ name, ops, ns: minNs })
  console.log(`  ${name.padEnd(48)} ${minNs.toFixed(1).padStart(10)} ns/op`)
}

async function benchAsync (name, ops, fn) {
  // Warmup
  for (let i = 0; i < Math.min(200, ops); i++) await fn()

  const iters = 3
  let minNs = Infinity
  for (let r = 0; r < iters; r++) {
    const t0 = performance.now()
    for (let i = 0; i < ops; i++) await fn()
    const t1 = performance.now()
    const ns = ((t1 - t0) * 1e6) / ops
    if (ns < minNs) minNs = ns
  }

  results.push({ name, ops, ns: minNs })
  console.log(`  ${name.padEnd(48)} ${minNs.toFixed(1).padStart(10)} ns/op`)
}

function section (title) {
  console.log(`\n=== ${title}${PURE ? ' (PURE, no tracer)' : ''} ===`)
}

// ----------------------------------------------------------------------------
// 1. Pure graphql execution — baseline per-query cost
// ----------------------------------------------------------------------------

async function benchPureGraphql () {
  section('1. graphql.execute end-to-end (6-query batch from sirun)')

  const source = `
    {
      friends {
        name
        address { civicNumber street }
        pets { type name owner { name } }
      }
    }
  `

  // Warmup once to let V8 JIT and patchedTypes WeakSet stabilize.
  await graphql.graphql({ schema, source })

  const iters = 10
  const queriesPerIter = 6
  let minMs = Infinity
  for (let r = 0; r < iters; r++) {
    const t0 = performance.now()
    const promises = []
    for (let i = 0; i < queriesPerIter; i++) {
      promises.push(graphql.graphql({ schema, source }))
    }
    await Promise.all(promises)
    const t1 = performance.now()
    const ms = t1 - t0
    if (ms < minMs) minMs = ms
  }

  const fieldsPerQuery = 1 /* friends */ +
    20 /* humans */ * (1 /* name */ + 1 /* address */ + 2 /* civic/street */ +
      1 /* pets */ + 20 /* pets */ * (1 /* type */ + 1 /* name */ + 1 /* owner */ + 1 /* owner.name */))
  const totalFields = fieldsPerQuery * queriesPerIter

  console.log(`  6-query batch                                    ${minMs.toFixed(2).padStart(10)} ms`)
  console.log(`  per-query                                        ${(minMs / queriesPerIter).toFixed(2).padStart(10)} ms`)
  console.log(`  per-field                                        ${((minMs * 1e6) / totalFields).toFixed(1).padStart(10)} ns  (~${totalFields} fields/batch)`)

  results.push({ name: 'graphql 6-query batch (ms)', ops: queriesPerIter, ns: minMs * 1e6 })
}

// ----------------------------------------------------------------------------
// 2. dc.channel.publish cost — measure the baseline channel-publish overhead
// ----------------------------------------------------------------------------

function benchChannelPublish () {
  section('2. dc.channel.publish overhead')

  const ch = dc.channel('microbench:no-subs')
  const chWith = dc.channel('microbench:with-sub')
  chWith.subscribe(() => {})

  const payload = { a: 1 }

  bench('publish with zero subscribers', 1e6, () => ch.publish(payload))
  bench('publish with one subscriber',   1e6, () => chWith.publish(payload))
}

// ----------------------------------------------------------------------------
// 3. Our wrapResolve fast path (no subscribers) — measure the tail-call cost
// ----------------------------------------------------------------------------

function benchWrapResolveFastPath () {
  section('3. wrapResolve fast path (startResolveCh has no subscribers)')

  // Reach into the plugin's module for the wrap helpers. The plugin internals
  // expose wrapResolve implicitly via the first bindStart call. Simpler: build
  // a standalone replica with the same shape to measure the closure cost.
  const unsubChannel = dc.channel('microbench:wrapresolve:nosub')

  function makeWrappedResolver (resolve) {
    return function wrapped (source, args, contextValue, info) {
      if (!unsubChannel.hasSubscribers) return resolve.apply(this, arguments)
      return resolve.apply(this, arguments)
    }
  }

  const resolver = function (source, args) { return args }
  const wrapped = makeWrappedResolver(resolver)

  bench('direct resolver call',      1e7, () => resolver({}, { n: 1 }))
  bench('wrapped resolver (no subs)', 1e7, () => wrapped({}, { n: 1 }, {}, {}))
}

// ----------------------------------------------------------------------------
// 4. assertField cost — pathToArray + join + publish + object alloc
// ----------------------------------------------------------------------------

function benchAssertField () {
  section('4. assertField (pathToArray + pathString + publish + obj alloc)')

  const ch = dc.channel('microbench:assertfield')
  ch.subscribe(() => {})

  function pathToArray (path) {
    const flattened = []
    let curr = path
    while (curr) {
      flattened.push(curr.key)
      curr = curr.prev
    }
    return flattened.reverse()
  }

  function assertField (rootCtx, info, args) {
    const path = pathToArray(info?.path)
    const pathString = path.join('.')
    const fields = rootCtx.fields
    let field = fields[pathString]
    if (!field) {
      const fieldCtx = { info, rootCtx, args, path, pathString }
      ch.publish(fieldCtx)
      field = fields[pathString] = { error: null, ctx: fieldCtx }
    }
    return field
  }

  // Deep path to exercise the linked-list walk: friends.0.pets.0.owner.name
  const info = {
    fieldName: 'name',
    path: {
      key: 'name',
      prev: { key: 0, prev: { key: 'owner', prev: { key: 0, prev: { key: 'pets', prev: { key: 0, prev: { key: 'friends' } } } } } }
    },
  }

  bench('assertField (first hit — publishes)', 1e5, () => {
    const rootCtx = { fields: Object.create(null) }
    assertField(rootCtx, info, { n: 1 })
  })

  // Cached path — second+ hits don't publish.
  const cachedRootCtx = { fields: Object.create(null) }
  assertField(cachedRootCtx, info, { n: 1 })
  bench('assertField (cache hit — no publish)', 1e6, () => {
    assertField(cachedRootCtx, info, { n: 1 })
  })
}

// ----------------------------------------------------------------------------
// 5. callInAsyncScope overhead — try/catch + Promise.then chain
// ----------------------------------------------------------------------------

function benchCallInAsyncScope () {
  section('5. callInAsyncScope (try/catch + Promise.then wrap)')

  function callInAsyncScope (fn, thisArg, args, ac, cb) {
    cb = cb || (() => {})
    if (ac?.signal.aborted) { cb(null, null); throw new Error('Aborted') }
    try {
      const result = fn.apply(thisArg, args)
      if (result && typeof result.then === 'function') {
        return result.then(res => { cb(null, res); return res }, err => { cb(err); throw err })
      }
      cb(null, result)
      return result
    } catch (err) {
      cb(err)
      throw err
    }
  }

  const ac = new AbortController()
  const asyncResolver = async () => 'world'
  const syncResolver = () => 'world'
  const cb = () => {}

  bench('direct sync resolver call',           1e7, () => syncResolver())
  bench('callInAsyncScope(sync resolver)',     1e7, () => callInAsyncScope(syncResolver, null, [], ac, cb))
  return (async () => {
    await benchAsync('direct async resolver call (awaited)', 2e4, async () => { await asyncResolver() })
    await benchAsync('callInAsyncScope(async resolver)',    2e4, async () => { await callInAsyncScope(asyncResolver, null, [], ac, cb) })
  })()
}

// ----------------------------------------------------------------------------
// 6. startSpan cost — opentracing Span allocation
// ----------------------------------------------------------------------------

function benchStartSpan () {
  section('6. TracingPlugin.startSpan (Span allocation)')

  if (PURE) { console.log('  skipped in PURE mode'); return }

  // We need a real plugin instance. Grab the graphql composite plugin.
  const tracer = require('../../..')
  const pluginManager = tracer._tracer?._pluginManager || tracer._pluginManager
  const composite = pluginManager?._pluginsByName?.graphql
  const executePlugin = composite?.modelcontextprotocol_execute ||
    composite?.execute ||
    composite?.plugins?.execute
  if (!executePlugin) {
    console.log('  skipped: could not locate execute plugin instance')
    return
  }

  bench('execute plugin startSpan', 1e5, () => {
    const span = executePlugin.startSpan('microbench.span', {
      service: 'test',
      type: 'graphql',
      meta: { 'graphql.operation.type': 'query' },
    }, {})
    span.finish()
  })
}

// ----------------------------------------------------------------------------
// 7. Per-phase breakdown of the real query hot path — time each channel handler
//    by wrapping it with a counter + accumulator. Tells us where the per-field
//    budget is actually spent across execute, resolve start/finish/updateField.
// ----------------------------------------------------------------------------

async function benchPhaseBreakdown () {
  section('7. Per-phase breakdown (wall-clock, one query)')
  if (PURE) { console.log('  skipped in PURE mode'); return }

  const source = `
    {
      friends {
        name
        address { civicNumber street }
        pets { type name owner { name } }
      }
    }
  `

  // Warmup
  await graphql.graphql({ schema, source })

  const phases = {
    executeStart: { n: 0, ns: 0n },
    executeEnd: { n: 0, ns: 0n },
    resolveStart: { n: 0, ns: 0n },
    resolveFinish: { n: 0, ns: 0n },
    resolveUpdateField: { n: 0, ns: 0n },
  }

  const subs = [
    ['tracing:orchestrion:graphql:apm:graphql:execute:start', 'executeStart'],
    ['tracing:orchestrion:graphql:apm:graphql:execute:end',   'executeEnd'],
    ['apm:graphql:resolve:start',                             'resolveStart'],
    ['apm:graphql:resolve:finish',                            'resolveFinish'],
    ['apm:graphql:resolve:updateField',                       'resolveUpdateField'],
  ]

  // Hook each channel to measure handler wall time. We install before-publish
  // observers — they run inside the publish loop but don't do real work.
  const installed = []
  for (const [channelName, key] of subs) {
    const ch = dc.channel(channelName)
    const handler = () => {
      phases[key].n += 1
    }
    ch.subscribe(handler)
    installed.push([ch, handler])
  }

  // Manual timer via hrtime.bigint around each publish wouldn't help — we'd
  // measure the publish overhead, not the plugin's handler. Instead, count the
  // publishes per-query to understand frequency, and compare against the total
  // query time to reason about per-publish cost.

  const iters = 20
  const perIter = 1
  let minMs = Infinity
  for (let r = 0; r < iters; r++) {
    for (const v of Object.values(phases)) { v.n = 0 }
    const t0 = performance.now()
    for (let q = 0; q < perIter; q++) {
      await graphql.graphql({ schema, source })
    }
    const t1 = performance.now()
    const ms = t1 - t0
    if (ms < minMs) minMs = ms
  }

  console.log(`  1-query latency                                  ${minMs.toFixed(2).padStart(10)} ms`)
  for (const [key, v] of Object.entries(phases)) {
    console.log(`  ${key.padEnd(48)} ${String(v.n).padStart(10)} publishes/query`)
  }

  // Cleanup
  for (const [ch, handler] of installed) ch.unsubscribe(handler)
}

// ----------------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------------

async function main () {
  const only = process.argv[2]
  const all = [
    ['graphql', benchPureGraphql],
    ['publish', benchChannelPublish],
    ['wrapResolve', benchWrapResolveFastPath],
    ['assertField', benchAssertField],
    ['callInAsyncScope', benchCallInAsyncScope],
    ['startSpan', benchStartSpan],
    ['phases', benchPhaseBreakdown],
  ]

  for (const [key, fn] of all) {
    if (only && !key.toLowerCase().includes(only.toLowerCase())) continue
    await fn()
  }

  console.log('\n=== summary ===')
  for (const r of results) {
    console.log(`  ${r.name.padEnd(48)} ${r.ns.toFixed(1).padStart(10)} ns/op`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
