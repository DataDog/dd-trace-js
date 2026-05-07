'use strict'

// TODO: Update setup script to not leave agent process running in background.

const assert = require('node:assert/strict')

// AgentExporter and several other internals register exit handlers via
// `globalThis[Symbol.for('dd-trace')].beforeExitHandlers`. The shared registry
// is normally created by `require('dd-trace')` (entry point); since the bench
// imports the src files directly to keep init cost out of the hot path, the
// registry has to be primed manually. Same shape as `llmobs/index.js`.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const hostname = require('os').hostname()
const SpanProcessor = require('../../../packages/dd-trace/src/span_processor')
const Exporter = require('../../../packages/dd-trace/src/exporters/agent/index')
const PrioritySampler = require('../../../packages/dd-trace/src/priority_sampler')
const id = require('../../../packages/dd-trace/src/id')
const { defaults } = require('../../../packages/dd-trace/src/config/defaults')

const config = {
  url: `http://${defaults.hostname}:${defaults.port}`,
  flushInterval: 1000,
  flushMinSpans: 100,
  protocolVersion: process.env.ENCODER_VERSION,
  stats: {
    enabled: process.env.WITH_STATS === '1',
  },
}
const prioritySampler = new PrioritySampler()
const exporter = new Exporter(config, prioritySampler)
const sp = new SpanProcessor(exporter, prioritySampler, config)

const finished = []
const trace = { finished, started: finished, tags: {} }

function createSpan (parent) {
  const spanId = id(0)
  const context = {
    _trace: trace,
    _spanId: spanId,
    _name: 'this is a name',
    _traceId: parent ? parent.context()._traceId : spanId,
    _parentId: parent ? parent.context()._spanId : id(0),
    _hostname: hostname,
    _sampling: {},
    _tags: {
      'service.name': 'hello',
      a: 'b',
      and: 'this is a longer string, just because we want to test some longer strongs, got it? okay',
      b: 45,
      something: 98764389,
      afloaty: 203987465.756754,
    },
  }
  const span = {
    context: () => context,
    tracer: () => { return { _service: 'exporting-pipeline-sirun' } },
    setTag: () => {},
    _startTime: 1415926,
    _duration: 100,
  }
  finished.push(span)
  return span
}

for (let i = 0, parent = null; i < 30; i++) {
  parent = createSpan(parent)
}

// Pre-flight sanity: confirm one process() call advances the writer's queue.
// Catches the silent breakage where a refactor wires the bench at a no-op
// surface (e.g. processor or exporter accepting input but discarding it).
const writerCountBefore = exporter._writer?._encoder?.count?.() ?? 0
sp.process(finished[0])
const writerCountAfter = exporter._writer?._encoder?.count?.() ?? 0
assert.ok(writerCountAfter > writerCountBefore, 'span processor did not advance encoder count')

let iterations = 1
function processSpans () {
  sp.process(finished[0])
  trace.finished = finished
  trace.started = finished
  if (++iterations < 250) {
    setImmediate(processSpans)
  }
}
processSpans()
