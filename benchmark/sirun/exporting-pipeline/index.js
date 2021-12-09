'use strict'

const SpanProcessor = require('../../../packages/dd-trace/src/span_processor')
const Exporter = require('../../../packages/dd-trace/src/exporters/agent/index')
const PrioritySampler = require('../../../packages/dd-trace/src/priority_sampler')
const id = require('../../../packages/dd-trace/src/id')
const hostname = require('os').hostname()

const prioritySampler = new PrioritySampler()
const exporter = new Exporter({
  url: 'http://localhost:8126',
  flushInterval: 2000,
  protocolVersion: process.env.ENCODER_VERSION
}, prioritySampler)
const sp = new SpanProcessor(exporter, prioritySampler)

const finished = []
const trace = { finished, started: finished }

function createSpan (parent) {
  const spanId = id()
  const context = {
    _trace: trace,
    _spanId: spanId,
    _name: 'this is a name',
    _traceId: parent ? parent.context()._traceId : spanId,
    _parentId: parent ? parent.context()._spanId : id(0),
    _hostname: hostname,
    _sampling: {},
    _traceFlags: {},
    _tags: {
      a: 'b',
      hello: 'world',
      and: 'this is a longer string, just because we want to test some longer strongs, got it? okay',
      b: 45,
      something: 98764389,
      afloaty: 203987465.756754
    }
  }
  const span = {
    context: () => context,
    tracer: () => ({}),
    _startTime: 1415926,
    _duration: 100
  }
  finished.push(span)
  return span
}

for (let i = 0, parent = null; i < 30; i++) {
  parent = createSpan(parent)
}

let iterations = 0
function processSpans () {
  sp.process(finished[0])
  trace.finished = finished
  trace.started = finished
  if (++iterations < 25000) {
    setImmediate(processSpans)
  }
}
processSpans()
