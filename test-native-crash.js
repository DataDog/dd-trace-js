// Test to reproduce native crash
const tracer = require('./packages/dd-trace').init({
  service: 'test-native-crash',
  flushInterval: 0
})

const fs = require('fs')
const { channel } = require('dc-polyfill')
const plugins = require('./packages/dd-trace/src/plugins')

// Register fs plugin
plugins.fs = require('./packages/datadog-plugin-fs/src')
channel('dd-trace:instrumentation:load').publish({ name: 'fs' })
tracer.use('fs', { enabled: true })

const ddTracer = tracer._tracer
console.log('Native spans enabled:', !!ddTracer._nativeSpans)

// Create parent span
const parentSpan = tracer.startSpan('parent')
console.log('Created parent span:', parentSpan._name)

tracer.scope().activate(parentSpan, () => {
  console.log('In scope, calling writeFileSync...')

  try {
    fs.writeFileSync('/tmp/test-native-crash.txt', 'hello')
    console.log('writeFileSync done')
  } catch (e) {
    console.error('Error during writeFileSync:', e)
  }

  // Check what spans were created
  const trace = parentSpan.context()._trace
  console.log('\nTrace state:')
  console.log('trace.started:', trace.started.length)
  for (const s of trace.started) {
    console.log('  - name:', s._name)
    console.log('    type:', s.constructor.name)
    const ctx = s.context()
    console.log('    spanId:', ctx._spanId?.toString())
  }
})

console.log('\nFinishing parent span...')
parentSpan.finish()

console.log('Waiting for flush...')
setTimeout(() => {
  console.log('Done')
  process.exit(0)
}, 1000)
