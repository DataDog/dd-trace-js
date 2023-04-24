const {
  ENCODER_VERSION
} = process.env

const { AgentEncoder } = require(`../../../packages/dd-trace/src/encode/${ENCODER_VERSION}`)
const id = require('../../../packages/dd-trace/src/id')

const writer = {
  flush: () => {}
}

function createSpan (parent) {
  const spanId = id()
  return {
    trace_id: parent ? parent.trace_id : spanId,
    span_id: spanId,
    parent_id: parent ? parent.parent_id : id(0),
    name: 'this is a name',
    resource: 'this is a resource',
    error: 0,
    start: 1415926535897,
    duration: 100,
    meta: {
      a: 'b',
      hello: 'world',
      and: 'this is a longer string, just because we want to test some longer strongs, got it? okay'
    },
    metrics: {
      b: 45,
      something: 98764389,
      afloaty: 203987465.756754
    }
  }
}

const trace = []
for (let parent = null, i = 0; i < 30; i++) {
  const span = createSpan(parent)
  trace.push(span)
  parent = span
}

const encoder = new AgentEncoder(writer)

for (let j = 0; j < 5000; j++) {
  encoder.encode(trace)
}
