'use strict'

// Shimmer required: NATS consumer paths need argument modification — the user's
// `opts.callback` is wrapped before being handed to SubscriptionImpl, and the
// returned subscription's async iterator is wrapped so iterator-style consumers
// get receive events. Orchestrion can only wrap method calls, not arguments
// or returned iterables.

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const publishStartCh = channel('apm:nats:publish:start')
const publishFinishCh = channel('apm:nats:publish:finish')
const publishErrorCh = channel('apm:nats:publish:error')

const consumeStartCh = channel('apm:nats:consume:start')
const consumeFinishCh = channel('apm:nats:consume:finish')
const consumeErrorCh = channel('apm:nats:consume:error')

// Tracks connections that are currently inside a `request`/`requestMany` call
// so the nested `this.publish(...)` they issue short-circuits without creating
// a second producer span (the outer request wrap already created one and
// injected headers — the inner publish would double-count it). A WeakSet avoids
// changing the shape of the user's connection object.
const requestsInFlight = new WeakSet()

// Captured from the `lib/headers.js` hook below. The nats-core package always
// imports `./headers` from `lib/nats.js`, so by the time we wrap `publish` the
// reference is set. No defensive checks needed at call sites.
let createHeaders

addHook({ name: '@nats-io/nats-core', versions: ['>=3.0.0'], file: 'lib/headers.js' }, exports => {
  createHeaders = exports.headers
  return exports
})

// transport-node re-exports nats-core internals — the passthrough hook ensures
// the package name is registered so `withVersions('nats', '@nats-io/transport-node', ...)`
// can resolve it in plugin tests.
addHook({ name: '@nats-io/transport-node', versions: ['>=3.0.0'] }, exports => exports)

function wrapSyncProducer (original, type) {
  return function (subject, data, options) {
    if (!publishStartCh.hasSubscribers) {
      return original.apply(this, arguments)
    }
    const opts = { ...(options ?? {}) }
    const ctx = { type, subject, data, options: opts, connection: this, createHeaders }
    return publishStartCh.runStores(ctx, () => {
      try {
        return original.call(this, subject, data, opts)
      } catch (err) {
        ctx.error = err
        publishErrorCh.publish(ctx)
        throw err
      } finally {
        publishFinishCh.publish(ctx)
      }
    })
  }
}

// publish is also wrapped by `wrapSyncProducer`, but request/requestMany call
// `this.publish(...)` internally. Set a marker on the connection so the inner
// publish wrap short-circuits — see `wrapPublish`.
function wrapAsyncProducer (original, type) {
  return function (subject, data, options) {
    if (!publishStartCh.hasSubscribers) {
      return original.apply(this, arguments)
    }
    const opts = { ...(options ?? {}) }
    const ctx = { type, subject, data, options: opts, connection: this, createHeaders }
    return publishStartCh.runStores(ctx, () => {
      requestsInFlight.add(this)
      let promise
      try {
        // `request`/`requestMany` never throw synchronously — they wrap their own
        // input validation in a try/catch that returns `Promise.reject`.
        promise = original.call(this, subject, data, opts)
      } finally {
        // The nested `this.publish(...)` runs during the synchronous body of
        // request/requestMany, so clearing the marker as soon as the call
        // returns is sufficient — the promise resolution happens later.
        requestsInFlight.delete(this)
      }
      return Promise.resolve(promise).then(
        result => {
          ctx.result = result
          publishFinishCh.publish(ctx)
          return result
        },
        err => {
          ctx.error = err
          publishErrorCh.publish(ctx)
          publishFinishCh.publish(ctx)
          throw err
        }
      )
    })
  }
}

function wrapPublish (original) {
  const wrapped = wrapSyncProducer(original, 'publish')
  return function (subject, data, options) {
    // Called from inside request/requestMany — the outer wrap already produced
    // a span and injected headers; running the inner wrap would double-count.
    if (requestsInFlight.has(this)) {
      return original.apply(this, arguments)
    }
    return wrapped.apply(this, arguments)
  }
}

function wrapSubscribeCallback (userCallback, subject, connection) {
  return function (err, message) {
    if (!message || err) {
      return userCallback.call(this, err, message)
    }
    const ctx = { subject, message, connection }
    return consumeStartCh.runStores(ctx, () => {
      try {
        return userCallback.call(this, err, message)
      } catch (e) {
        ctx.error = e
        consumeErrorCh.publish(ctx)
        throw e
      } finally {
        consumeFinishCh.publish(ctx)
      }
    })
  }
}

// Iterator-style consumers don't expose a delivery callback we can wrap, so
// the consume span represents the moment of receipt only — it starts and
// finishes before the value is yielded to user code, and the user's loop
// body is not parented under the span.
function wrapAsyncIteratorFactory (asyncIterator, subject, connection) {
  return function () {
    const iterator = asyncIterator.apply(this, arguments)
    iterator.next = shimmer.wrapCallback(iterator.next, next => function () {
      return next.apply(this, arguments).then(result => {
        if (result && !result.done && result.value) {
          const ctx = { subject, message: result.value, connection }
          consumeStartCh.runStores(ctx, () => {
            consumeFinishCh.publish(ctx)
          })
        }
        return result
      })
    })
    return iterator
  }
}

addHook({ name: '@nats-io/nats-core', versions: ['>=3.0.0'], file: 'lib/nats.js' }, exports => {
  const proto = exports.NatsConnectionImpl.prototype

  shimmer.wrap(proto, 'publish', wrapPublish)
  shimmer.wrap(proto, 'request', request => wrapAsyncProducer(request, 'request'))
  shimmer.wrap(proto, 'requestMany', requestMany => wrapAsyncProducer(requestMany, 'requestMany'))

  shimmer.wrap(proto, 'subscribe', subscribe => function (subject, opts) {
    if (!consumeStartCh.hasSubscribers) {
      return subscribe.apply(this, arguments)
    }

    const userOpts = opts ?? {}
    if (typeof userOpts.callback === 'function') {
      arguments[1] = { ...userOpts, callback: wrapSubscribeCallback(userOpts.callback, subject, this) }
      return subscribe.apply(this, arguments)
    }

    const sub = subscribe.apply(this, arguments)
    shimmer.wrap(sub, Symbol.asyncIterator, asyncIterator =>
      wrapAsyncIteratorFactory(asyncIterator, subject, this))
    return sub
  })

  return exports
})
