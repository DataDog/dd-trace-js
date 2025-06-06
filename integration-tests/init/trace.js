/* eslint-disable no-console */
console.log(!!global._ddtrace)
console.log('instrumentation source:', global._ddtrace._tracer._config.instrumentationSource)
process.exit()
