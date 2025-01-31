const tracer = require('./init')

const span = tracer.startSpan('test')

console.log(span)
