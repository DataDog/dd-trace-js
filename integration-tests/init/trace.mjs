// eslint-disable-next-line no-console
console.log(!!global._ddtrace)
if (global._ddtrace?._tracer) {
  // eslint-disable-next-line no-console
  console.log('instrumentation source:', global._ddtrace._tracer._config.instrumentationSource)
}
process.exit()
