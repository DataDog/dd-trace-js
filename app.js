const tracer = require('./dist/dd-trace.bundle').init()

const span = tracer.startSpan('test')

console.log(span)
