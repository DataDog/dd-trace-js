'use strict'

const dc = require('dc-polyfill')
const { addHook } = require('./helpers/instrument')

// The SDK's `Query.prototype[Symbol.asyncIterator]() { return this.sdkMessages }`
// shortcut breaks the canonical async-iterable protocol — `for await (msg of q)`
// iterates `sdkMessages.next()` directly instead of `q.next/return/throw` (which
// the SDK itself defines and orchestrion's `traceAsyncIterator` has wrapped).
// Restore the canonical protocol so iteration goes through the traced methods
// (and through the SDK's own `cleanup()` hook on early termination).
//
// We observe the prototype off the freshly-returned Query via orchestrion's
// `:query:end` channel — no `shimmer.wrap` on `exports`, so this works whether
// the SDK was loaded via IITM (mutable namespace) or CJS `require()` of ESM
// (sealed namespace).
const patched = new WeakSet()

dc.channel('tracing:orchestrion:@anthropic-ai/claude-agent-sdk:query:end').subscribe(ctx => {
  const q = ctx?.result
  if (!q || typeof q !== 'object') return
  const proto = Object.getPrototypeOf(q)
  if (!proto || patched.has(proto)) return
  proto[Symbol.asyncIterator] = function () { return this }
  patched.add(proto)
})

addHook({ name: '@anthropic-ai/claude-agent-sdk', versions: ['>=0.3.152'] }, exports => exports)
