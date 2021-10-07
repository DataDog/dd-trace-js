const tracer = require('../../..').init()

tracer._tracer._processor.process = function process (span) {
  const trace = span.context()._trace
  this._erase(trace)
}

const { FINISH } = process.env

const spans = []

for (let i = 0; i < 100000; i++) {
  const span = tracer.startSpan('some.span.name', {})
  if (FINISH === 'now') {
    span.finish()
  } else {
    spans.push(span)
  }
}

if (FINISH !== 'now') {
  for (let i = 0; i < 100000; i++) {
    spans[i].finish()
  }
}
