'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const {
  AgentlessCiVisibilityEncoder,
} = require('../../../packages/dd-trace/src/encode/agentless-ci-visibility')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const ENCODE_COUNT = Number(process.env.ENCODE_COUNT) || 60_000

// Test optimization ships every test, suite, module and session event through
// the agentless CI-visibility msgpack encoder: truncateSpanTestOpt, normalizeSpan,
// then the per-event-type map encode. This is the test-event egress hot path, the
// CI sibling of the `encoding` (trace) bench. Build a realistic session payload
// and drive encode()+makePayload() over it. The encoder normalizes copies, so the
// source trace is reused untouched across iterations.
const SESSION_ID = '7100000000000001'
const MODULE_ID = '7100000000000002'

function baseMeta (extra) {
  return {
    language: 'javascript',
    'test.framework': 'mocha',
    'test.framework_version': '10.2.0',
    'os.platform': 'linux',
    'runtime.name': 'node',
    test_session_id: SESSION_ID,
    test_module_id: MODULE_ID,
    ...extra,
  }
}

function buildTest (i, suiteId, wide) {
  const suite = `packages/module/test/feature-${i % 20}.spec.js`
  const meta = baseMeta({
    test_suite_id: suiteId,
    'test.name': `handles scenario ${i}`,
    'test.suite': suite,
    'test.status': 'pass',
    'test.type': 'test',
  })
  if (wide) {
    for (let t = 0; t < 25; t++) meta[`test.tag.${t}`] = `value-${t}`
  }
  return {
    type: 'test',
    trace_id: id(),
    span_id: id(),
    parent_id: id('0'),
    name: 'mocha.test',
    resource: `${suite}.handles scenario ${i}`,
    service: 'my-service',
    error: 0,
    start: 1_716_950_000_000_000_000 + i * 1000,
    duration: 1_500_000 + i,
    meta,
    metrics: { 'test.source.start': 12, 'test.source.end': 48, _dd_top_level: 1 },
  }
}

function buildTrace (testCount, suiteCount, wide) {
  const trace = [
    {
      type: 'test_session_end',
      trace_id: id(SESSION_ID, 10),
      span_id: id(SESSION_ID, 10),
      parent_id: id('0'),
      name: 'mocha.test_session',
      resource: 'test_session.mocha test',
      service: 'my-service',
      error: 0,
      start: 1_716_950_000_000_000_000,
      duration: 9_000_000_000,
      meta: baseMeta({ 'test.command': 'mocha test', 'test.status': 'pass' }),
      metrics: { _dd_top_level: 1 },
    },
    {
      type: 'test_module_end',
      trace_id: id(SESSION_ID, 10),
      span_id: id(MODULE_ID, 10),
      parent_id: id('0'),
      name: 'mocha.test_module',
      resource: 'test_module.mocha',
      service: 'my-service',
      error: 0,
      start: 1_716_950_000_000_000_000,
      duration: 8_500_000_000,
      meta: baseMeta({ 'test.module': 'mocha', 'test.status': 'pass' }),
      metrics: { _dd_top_level: 1 },
    },
  ]
  for (let s = 0; s < suiteCount; s++) {
    const suiteId = `72000000000000${(s + 10).toString()}`
    trace.push({
      type: 'test_suite_end',
      trace_id: id(SESSION_ID, 10),
      parent_id: id(MODULE_ID, 10),
      span_id: id(suiteId, 10),
      name: 'mocha.test_suite',
      resource: `test_suite.packages/module/test/suite-${s}.spec.js`,
      service: 'my-service',
      error: 0,
      start: 1_716_950_000_000_000_000,
      duration: 2_000_000_000,
      meta: baseMeta({ 'test.suite': `suite-${s}`, 'test.status': 'pass' }),
      metrics: { _dd_top_level: 1 },
    })
    const perSuite = Math.ceil(testCount / suiteCount)
    for (let i = 0; i < perSuite; i++) {
      trace.push(buildTest(s * perSuite + i, suiteId, wide))
    }
  }
  return trace
}

const SHAPES = {
  'small-suite': { tests: 48, suites: 3, wide: false },
  'large-suite': { tests: 480, suites: 16, wide: false },
  'wide-tags': { tests: 96, suites: 4, wide: true },
}

const shape = SHAPES[VARIANT]
assert.ok(shape, `unknown VARIANT: ${VARIANT}`)

const trace = buildTrace(shape.tests, shape.suites, shape.wide)
const encoder = new AgentlessCiVisibilityEncoder(
  { flush () {} },
  { runtimeId: 'a1b2c3d4-0000-0000-0000-000000000000', service: 'my-service', env: 'ci' }
)

// Preflight: encode once and confirm the encoder buffered bytes and counted the
// events, then a second encode to confirm the source trace survives normalization
// (the encoder mutates only its per-encode copies).
encoder.encode(trace)
assert.ok(encoder._traceBytes.length > 0 && encoder._eventCount === trace.length,
  'CI encoder did not buffer the events')
encoder.encode(trace)
assert.equal(encoder._eventCount, trace.length * 2, 'second encode produced a different event count')
encoder.makePayload()
assert.equal(encoder._eventCount, 0, 'makePayload did not reset the encoder')

guard.loopStart()
let sink = 0
for (let iteration = 0; iteration < ENCODE_COUNT; iteration++) {
  encoder.encode(trace)
  sink += encoder.makePayload().length
}
guard.done()

if (sink === 0) throw new Error('unreachable')
