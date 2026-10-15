'use strict'

const assert = require('node:assert/strict')
const dc = require('dc-polyfill')
const Hook = require('../../src/ritm')

Hook([])
const stack = []
const roots = []
const mismatches = []
dc.channel('dd-trace:moduleLoadStart').subscribe(payload => stack.push(payload.filename))
dc.channel('dd-trace:moduleLoadEnd').subscribe(payload => {
  const filename = stack.pop()
  if (filename !== payload.filename) mismatches.push([filename, payload.filename])
  if (stack.length === 0) roots.push(payload.filename)
})

// On supported Node versions, register.js uses require() to load an ES-module
// helper and check whether synchronous loader hooks are available. With Lambda's
// --no-experimental-require-module flag, that require() throws ERR_REQUIRE_ESM.
// Registration catches it and falls back to asynchronous loader registration.
// The failed require must still emit an end event (without module exports), or
// subscribers such as the Lambda cold-start tracer retain an unfinished stack.
require('../../../../register')
const loaded = require('./module-load-parent')
assert.deepEqual(loaded, { loaded: true })
assert.deepEqual(mismatches, [])
assert.deepEqual(stack, [])
assert.ok(roots.includes(require.resolve('./module-load-parent')))

// Both the ESM entrypoint and its CJS dependency must remain loadable.
import('./loader-registration.mjs').then(namespace => {
  assert.deepEqual(namespace.default, loaded)
  assert.deepEqual(mismatches, [])
  assert.deepEqual(stack, [])
}).catch(error => {
  process.nextTick(() => { throw error })
})
