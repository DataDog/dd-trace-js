'use strict'

const preserveOtelContext = Symbol.for('dd-trace.otel.preserve_context')
const suppressOtelInstrumentation = Symbol.for('dd-trace.otel.suppress_instrumentation')

module.exports = { preserveOtelContext, suppressOtelInstrumentation }
