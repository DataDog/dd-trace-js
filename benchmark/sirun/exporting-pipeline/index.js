'use strict'

// TODO: Update setup script to not leave agent process running in background.

const SpanProcessor = require('../../../packages/dd-trace/src/span_processor')
const Exporter = require('../../../packages/dd-trace/src/exporters/agent/index')
const PrioritySampler = require('../../../packages/dd-trace/src/priority_sampler')
const id = require('../../../packages/dd-trace/src/id')
const defaults = require('../../../packages/dd-trace/src/config_defaults')
const hostname = require('os').hostname()

const config = {
  url: defaults.url,
  flushInterval: 1000,
  flushMinSpans: 100,
  protocolVersion: process.env.ENCODER_VERSION,
  stats: {
    enabled: process.env.WITH_STATS === '1'
  }
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
      afloaty: 203987465.756754
    }
  }
  const span = {
    context: () => context,
    tracer: () => { return { _service: 'exporting-pipeline-sirun' } },
    setTag: () => {},
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
  if (++iterations < 250) {
    setImmediate(processSpans)
  }
}
processSpans()
