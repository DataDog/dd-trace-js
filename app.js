const tracer = require('.').init()

const span = tracer.startSpan('web.request')

// span.finish()

console.log(span.context())
