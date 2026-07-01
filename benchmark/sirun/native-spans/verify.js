'use strict'

/**
 * Verification script — proves that the native code paths claimed by the
 * benchmarks are actually taken.
 *
 *   node verify.js
 *
 * Exit code 0 = all assertions passed.
 * Exit code 1 = a code-path assertion failed.
 *
 * Native spans are always on when libdatadog is available. If libdatadog
 * is not loadable on this platform the script exits early.
 */

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const nock = require('nock')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const nativeModule = require('../../../packages/dd-trace/src/native')

if (!nativeModule.available) {
  console.log('Native pipeline is unavailable on this platform; skipping verification.')
  process.exit(0)
}

console.log('\n=== Verifying native span pipeline ===\n')

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

check('tracer._nativeSpans is set', () => {
  assert.notEqual(internal._nativeSpans, null, '_nativeSpans should be set')
})

// -------------------------------------------------------------------
// 2. Span-level: correct span and context classes
// -------------------------------------------------------------------

const span = tracer.startSpan('verify.span', {
  tags: { 'http.method': 'GET', 'http.url': '/test', 'custom.num': 42 },
})

check('span uses NativeDatadogSpan class', () => {
  assert.equal(span.constructor.name, 'NativeDatadogSpan',
    `expected NativeDatadogSpan, got ${span.constructor.name}`)
})

check('span context uses NativeSpanContext class', () => {
  const ctx = span.context()
  assert.equal(ctx.constructor.name, 'NativeSpanContext',
    `expected NativeSpanContext, got ${ctx.constructor.name}`)
})

// -------------------------------------------------------------------
// 3. Tag accessors work
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
// 5. WASM state is alive and functional
// -------------------------------------------------------------------

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

// -------------------------------------------------------------------
// 6. Pipeline: native exporter is wired up
// -------------------------------------------------------------------

check('exporter is NativeExporter', () => {
  const exporter = internal._exporter
  assert.equal(exporter.constructor.name, 'NativeExporter',
    `expected NativeExporter, got ${exporter.constructor.name}`)
})

// -------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------

console.log('')
if (ok) {
  console.log('All native pipeline checks passed.\n')
  process.exit(0)
} else {
  console.log('Some native pipeline checks FAILED.\n')
  process.exit(1)
}
