'use strict'

/* global Bun */

// Runs under Bun. Verifies which channels survive a full garbage collection when nothing else references them.

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const dc = require('dc-polyfill')

require('../../../../..')

const delivered = []

dc.channel('test:channel').subscribe(() => delivered.push('channel'))
dc.subscribe('test:top-level', () => delivered.push('top-level'))
dc.tracingChannel('test:tracing').subscribe({ start: () => delivered.push('tracing') })
dc.channel('test:store').bindStore(new AsyncLocalStorage())

const unsubscribed = new WeakRef(dc.channel('test:unsubscribed'))
const handler = () => {}
dc.subscribe('test:unsubscribed', handler)
dc.unsubscribe('test:unsubscribed', handler)

const unbound = new WeakRef(dc.channel('test:unbound'))
const store = new AsyncLocalStorage()
dc.channel('test:unbound').bindStore(store)
dc.channel('test:unbound').unbindStore(store)

const storeOnly = new WeakRef(dc.channel('test:mixed:store'))
dc.channel('test:mixed:store').subscribe(handler)
dc.channel('test:mixed:store').bindStore(store)
dc.channel('test:mixed:store').unsubscribe(handler)

const subscriberOnly = new WeakRef(dc.channel('test:mixed:subscriber'))
const mixedHandler = () => delivered.push('mixed')
dc.channel('test:mixed:subscriber').bindStore(store)
dc.channel('test:mixed:subscriber').subscribe(mixedHandler)
dc.channel('test:mixed:subscriber').unbindStore(store)

setImmediate(() => {
  gc()

  dc.channel('test:channel').publish({})
  dc.channel('test:top-level').publish({})
  dc.channel('tracing:test:tracing:start').publish({})

  const bound = storeOnly.deref()
  assert.ok(bound, 'the remaining bound store keeps the channel alive')
  assert.strictEqual(bound.runStores('context', () => store.getStore()), 'context')
  bound.unbindStore(store)

  const subscribed = subscriberOnly.deref()
  assert.ok(subscribed, 'the remaining subscriber keeps the channel alive')
  subscribed.publish({})
  subscribed.unsubscribe(mixedHandler)

  const result = {
    delivered,
    storeBound: dc.hasSubscribers('test:store'),
    unsubscribedCollected: unsubscribed.deref() === undefined,
    unboundCollected: unbound.deref() === undefined,
  }

  // WeakRef.deref() keeps its target alive until the end of the current turn.
  setImmediate(() => {
    gc()
    assert.strictEqual(storeOnly.deref(), undefined)
    assert.strictEqual(subscriberOnly.deref(), undefined)
    process.stdout.write(JSON.stringify(result))
  })
})

function gc () {
  // @ts-expect-error Bun globals are not typed in this repository.
  Bun.gc(true)
}
