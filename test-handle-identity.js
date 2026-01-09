// Trace handle identity
const datadog = require('./packages/datadog-core')
const legacyStorage = datadog.storage('legacy')
const originalEnterWith = legacyStorage.enterWith.bind(legacyStorage)
const originalGetHandle = legacyStorage.getHandle.bind(legacyStorage)

let handleId = 0
const handleIds = new WeakMap()
const storeForHandle = new WeakMap()

function getHandleId(handle) {
  if (!handle) return 'null'
  if (!handleIds.has(handle)) {
    handleIds.set(handle, ++handleId)
  }
  return `H${handleIds.get(handle)}`
}

legacyStorage.enterWith = function(store) {
  const result = originalEnterWith(store)
  const handle = legacyStorage.getHandle()
  storeForHandle.set(handle, store)
  const hasNoop = store?.noop ? 'noop:true' : 'noop:false'
  console.log(`[enterWith] ${hasNoop}, handle=${getHandleId(handle)}`)
  return result
}

legacyStorage.getHandle = function() {
  const handle = originalGetHandle()
  console.log(`[getHandle] => ${getHandleId(handle)}`)
  return handle
}

console.log('=== Starting tracer.init() ===\n')
const tracer = require('./packages/dd-trace').init({
  service: 'test-handle-identity',
  flushInterval: 0
})

console.log('\n=== tracer.init() completed ===')
console.log('Native spans:', !!tracer._tracer._nativeSpans)

// Now create a span and check
const storage = require('./packages/datadog-core').storage('legacy')

console.log('\n=== Before creating span ===')
const handleBefore = storage.getHandle()
console.log('Handle before:', getHandleId(handleBefore))
console.log('Store for handleBefore:', storage.getStore(handleBefore))

console.log('\n=== Creating parent span ===')
const parentSpan = tracer.startSpan('parent')
console.log('Parent span type:', parentSpan.constructor.name)
console.log('Parent._store handle:', getHandleId(parentSpan._store))
console.log('Store for Parent._store:', storage.getStore(parentSpan._store))

process.exit(0)
