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

let createHeaders = null

addHook({ name: '@nats-io/nats-core', versions: ['>=3.0.0'], file: 'lib/headers.js' }, exports => {
  if (typeof exports.headers === 'function') {
    createHeaders = exports.headers
  }
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
    const opts = options ?? {}
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

function wrapAsyncProducer (original, type) {
  return function (subject, data, options) {
    if (!publishStartCh.hasSubscribers) {
      return original.apply(this, arguments)
    }
    const opts = options ?? {}
    const ctx = { type, subject, data, options: opts, connection: this, createHeaders }
    return publishStartCh.runStores(ctx, () => {
      let promise
      try {
        promise = original.call(this, subject, data, opts)
      } catch (err) {
        ctx.error = err
        publishErrorCh.publish(ctx)
        publishFinishCh.publish(ctx)
        throw err
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

addHook({ name: '@nats-io/nats-core', versions: ['>=3.0.0'], file: 'lib/nats.js' }, exports => {
  const NatsConnectionImpl = exports.NatsConnectionImpl
  if (NatsConnectionImpl?.prototype) {
    shimmer.wrap(NatsConnectionImpl.prototype, 'publish', publish => wrapSyncProducer(publish, 'publish'))
    shimmer.wrap(NatsConnectionImpl.prototype, 'request', request => wrapAsyncProducer(request, 'request'))
    shimmer.wrap(NatsConnectionImpl.prototype, 'requestMany',
      requestMany => wrapAsyncProducer(requestMany, 'requestMany'))

    shimmer.wrap(NatsConnectionImpl.prototype, 'subscribe', subscribe => function (subject, opts) {
      if (!consumeStartCh.hasSubscribers) {
        return subscribe.apply(this, arguments)
      }

      const connection = this
      const userOpts = opts ?? {}
      const userCallback = typeof userOpts.callback === 'function' ? userOpts.callback : undefined

      if (userCallback) {
        const wrappedOpts = {
          ...userOpts,
          callback (err, message) {
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
          },
        }
        arguments[1] = wrappedOpts
        return subscribe.apply(this, arguments)
      }

      const sub = subscribe.apply(this, arguments)
      const originalIterate = sub.iterate.bind(sub)
      sub.iterate = async function * () {
        for await (const message of originalIterate()) {
          const ctx = { subject, message, connection }
          // Iterator-style consumers don't expose a delivery callback we can
          // wrap, so the consume span represents the moment of receipt only.
          // It starts and finishes before yielding to user code — user logic
          // is not parented under the consume span.
          consumeStartCh.runStores(ctx, () => {
            consumeFinishCh.publish(ctx)
          })
          yield message
        }
      }
      sub[Symbol.asyncIterator] = function () {
        return sub.iterate()
      }
      return sub
    })
  }
  return exports
})
