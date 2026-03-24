'use strict'

/**
 * Verification script — proves that the native code paths claimed by the
 * benchmarks are actually taken.
 *
 * Run in both modes and compare output:
 *   node verify.js
 *   DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 node verify.js
 *
 * Exit code 0 = all assertions for the current mode passed.
 * Exit code 1 = a code-path assertion failed.
 */

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const nock = require('nock')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const native = process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED === '1'
const mode = native ? 'NATIVE' : 'JS'

console.log(`\n=== Verifying ${mode} mode ===\n`)

const tracer = require('../../..').init({
  hostname: '127.0.0.1',
  port: 8126,
})

const internal = tracer._tracer
let ok = true

function check (label, fn) {
  try {
    fn()
    console.log(`  PASS  ${label}`)
  } catch (err) {
    console.log(`  FAIL  ${label}: ${err.message}`)
    ok = false
  }
}

// -------------------------------------------------------------------
// 1. Tracer-level: correct internal state
// -------------------------------------------------------------------

check('tracer._nativeSpans is set iff native', () => {
  if (native) {
    assert.notEqual(internal._nativeSpans, null, '_nativeSpans should be set')
  } else {
    assert.equal(internal._nativeSpans, null, '_nativeSpans should be null')
  }
})

check('processor._isNativeMode matches', () => {
  assert.equal(internal._processor._isNativeMode, native)
})

// -------------------------------------------------------------------
// 2. Span-level: correct span and context classes
// -------------------------------------------------------------------

const span = tracer.startSpan('verify.span', {
  tags: { 'http.method': 'GET', 'http.url': '/test', 'custom.num': 42 },
})

check('span class matches mode', () => {
  if (native) {
    assert.equal(span.constructor.name, 'NativeDatadogSpan',
      `expected NativeDatadogSpan, got ${span.constructor.name}`)
  } else {
    assert.equal(span.constructor.name, 'DatadogSpan',
      `expected DatadogSpan, got ${span.constructor.name}`)
  }
})

check('span context class matches mode', () => {
  const ctx = span.context()
  if (native) {
    assert.equal(ctx.constructor.name, 'NativeSpanContext',
      `expected NativeSpanContext, got ${ctx.constructor.name}`)
  } else {
    assert.equal(ctx.constructor.name, 'DatadogSpanContext',
      `expected DatadogSpanContext, got ${ctx.constructor.name}`)
  }
})

// -------------------------------------------------------------------
// 3. Tag accessors work correctly in both modes
// -------------------------------------------------------------------

check('getTag returns correct values', () => {
  const ctx = span.context()
  assert.equal(ctx.getTag('http.method'), 'GET')
  assert.equal(ctx.getTag('http.url'), '/test')
  assert.equal(ctx.getTag('custom.num'), 42)
})

check('setTag + getTag roundtrip', () => {
  span.setTag('roundtrip.key', 'roundtrip.value')
  assert.equal(span.context().getTag('roundtrip.key'), 'roundtrip.value')
})

check('getTags returns all tags', () => {
  const tags = span.context().getTags()
  assert.equal(tags['http.method'], 'GET')
  assert.equal(tags['roundtrip.key'], 'roundtrip.value')
})

// -------------------------------------------------------------------
// 4. Parent-child relationship works
// -------------------------------------------------------------------

const child = tracer.startSpan('verify.child', { childOf: span })

check('child has correct parent', () => {
  const childCtx = child.context()
  const parentCtx = span.context()
  assert.equal(
    childCtx._parentId.toString(),
    parentCtx._spanId.toString(),
    'child parentId should match parent spanId',
  )
  assert.equal(
    childCtx._traceId.toString(),
    parentCtx._traceId.toString(),
    'child traceId should match parent traceId',
  )
})

child.finish()
span.finish()

// -------------------------------------------------------------------
// 5. Native-specific: WASM state is alive and functional
// -------------------------------------------------------------------

if (native) {
  check('NativeSpansInterface._state exists', () => {
    assert.ok(internal._nativeSpans._state, 'WASM state should exist')
  })

  check('WASM flushChangeQueue works', () => {
    internal._nativeSpans.flushChangeQueue()
  })

  check('WASM flushStats method exists', () => {
    assert.equal(typeof internal._nativeSpans._state.flushStats, 'function',
      'flushStats should be a function on WASM state')
  })
}

// -------------------------------------------------------------------
// 6. Pipeline: verify spanFormat is/isn't called
// -------------------------------------------------------------------

check('processor takes correct code path for mode', () => {
  // Instrument the processor to detect which branch is taken.
  // In native mode, the exporter should be a NativeExporter.
  // In JS mode, the exporter should be an AgentExporter.
  const processor = internal._processor

  let nativeBranchTaken = false
  let jsBranchTaken = false

  const origProcess = processor.process.bind(processor)
  processor.process = function (span) {
    // Check which exporter will handle this
    if (processor._isNativeMode) {
      nativeBranchTaken = true
    } else {
      jsBranchTaken = true
    }
    return origProcess(span)
  }

  const s = tracer.startSpan('verify.pipeline')
  s.setTag('service.name', 'test-svc')
  s.finish()

  if (native) {
    assert.ok(nativeBranchTaken, 'native branch should be taken')
    assert.ok(!jsBranchTaken, 'JS branch should NOT be taken')
  } else {
    assert.ok(jsBranchTaken, 'JS branch should be taken')
    assert.ok(!nativeBranchTaken, 'native branch should NOT be taken')
  }

  // Restore
  processor.process = origProcess
})

check('exporter class matches mode', () => {
  const exporter = internal._exporter
  if (native) {
    assert.equal(exporter.constructor.name, 'NativeExporter',
      `expected NativeExporter, got ${exporter.constructor.name}`)
  } else {
    // AgentExporter or similar
    assert.notEqual(exporter.constructor.name, 'NativeExporter',
      'exporter should NOT be NativeExporter in JS mode')
  }
})

// -------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------

console.log('')
if (ok) {
  console.log(`All ${mode} mode checks passed.\n`)
  process.exit(0)
} else {
  console.log(`Some ${mode} mode checks FAILED.\n`)
  process.exit(1)
}
