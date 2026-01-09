// Patch storage BEFORE anything else
const datadog = require('./packages/datadog-core')
const legacyStorage = datadog.storage('legacy')
const originalEnterWith = legacyStorage.enterWith.bind(legacyStorage)
const callStack = []

legacyStorage.enterWith = function(store) {
  if (store?.noop) {
    const stack = new Error().stack.split('\n').slice(2, 6).join('\n')
    console.log('[NOOP] enterWith({ noop: true }) called from:')
    console.log(stack)
    console.log('')
    callStack.push(stack)
  }
  return originalEnterWith(store)
}

console.log('=== Starting tracer.init() ===\n')
const tracer = require('./packages/dd-trace').init({
  service: 'test-noop-trace',
  flushInterval: 0
})
console.log('\n=== tracer.init() completed ===')
console.log('Native spans:', !!tracer._tracer._nativeSpans)
console.log('Total noop enterWith calls:', callStack.length)

process.exit(0)
