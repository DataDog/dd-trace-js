'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:cassandra-driver:query:start')
const finishCh = channel('apm:cassandra-driver:query:finish')
const errorCh = channel('apm:cassandra-driver:query:error')
const connectCh = channel('apm:cassandra-driver:query:connect')

/** @type {Record<string, unknown> & { error?: Error }} */
let startCtx = {}

addHook({ name: 'cassandra-driver', versions: ['>=3.0.0'] }, cassandra => {
  shimmer.wrap(cassandra.Client.prototype, 'batch', batch => function (queries, options, callback) {
    if (!startCh.hasSubscribers) {
      return batch.apply(this, arguments)
    }
    const lastIndex = arguments.length - 1
    const cb = arguments[lastIndex]

    startCtx = { keyspace: this.keyspace, query: queries, contactPoints: this.options && this.options.contactPoints }
    return startCh.runStores(startCtx, () => {
      if (typeof cb === 'function') {
        arguments[lastIndex] = wrapCallback(startCtx, cb)
      }

      try {
        const res = batch.apply(this, arguments)
        if (typeof res === 'function') {
          return wrapCallback(startCtx, res)
        }
        if (!res) {
          return res
        }
        return res.then(
          () => finish(startCtx),
          err => finish(startCtx, err)
        )
      } catch (e) {
        finish(startCtx, e)
        throw e
      }
    })
  })
  return cassandra
})

addHook({ name: 'cassandra-driver', versions: ['>=4.4'], patchDefault: false }, (cassandra) => {
  shimmer.wrap(cassandra.Client.prototype, '_execute', _execute => function (query, params, execOptions, callback) {
    if (!startCh.hasSubscribers) {
      return _execute.apply(this, arguments)
    }
    startCtx = { keyspace: this.keyspace, query, contactPoints: this.options && this.options.contactPoints }
    return startCh.runStores(startCtx, () => {
      const promise = _execute.apply(this, arguments)

      promise.then(
        () => finish(startCtx),
        err => finish(startCtx, err)
      )
      return promise
    })
  })
  return cassandra
})

const isValid = (args) => {
  return args.length === 4 || typeof args[3] === 'function'
}

addHook({ name: 'cassandra-driver', versions: ['3 - 4.3'], patchDefault: false }, (cassandra) => {
  shimmer.wrap(cassandra.Client.prototype, '_innerExecute', _innerExecute =>
    function (query, params, execOptions, callback) {
      if (!startCh.hasSubscribers || !isValid(arguments)) {
        return _innerExecute.apply(this, arguments)
      }

      startCtx = { keyspace: this.keyspace, query, contactPoints: this.options && this.options.contactPoints }
      return startCh.runStores(startCtx, () => {
        const lastIndex = arguments.length - 1
        const cb = arguments[lastIndex]

        if (typeof cb === 'function') {
          arguments[lastIndex] = wrapCallback(startCtx, cb)
        }

        try {
          return _innerExecute.apply(this, arguments)
        } catch (e) {
          finish(startCtx, e)
          throw e
        }
      })
    }
  )
  return cassandra
})

addHook({ name: 'cassandra-driver', versions: ['>=3.3'], file: 'lib/request-execution.js' }, RequestExecution => {
  shimmer.wrap(RequestExecution.prototype, '_sendOnConnection', _sendOnConnection => function (...args) {
    if (!startCh.hasSubscribers) {
      return _sendOnConnection.apply(this, args)
    }
    startCtx = { hostname: this._connection.address, port: this._connection.port, ...startCtx }
    connectCh.publish(startCtx)
    return _sendOnConnection.apply(this, args)
  })
  return RequestExecution
})

addHook({ name: 'cassandra-driver', versions: ['3.3 - 4.3'], file: 'lib/request-execution.js' }, RequestExecution => {
  shimmer.wrap(RequestExecution.prototype, 'start', start => function (getHostCallback) {
    if (!startCh.hasSubscribers) {
      return getHostCallback.apply(this, arguments)
    }
    const execution = this

    if (!isRequestValid(this, arguments, 1)) {
      return start.apply(this, arguments)
    }

    arguments[0] = function (...args) {
      startCtx = { hostname: execution._connection.address, port: execution._connection.port, ...startCtx }
      return connectCh.runStores(startCtx, getHostCallback, this, ...args)
    }

    return start.apply(this, arguments)
  })
  return RequestExecution
})

addHook({ name: 'cassandra-driver', versions: ['3 - 3.2'], file: 'lib/request-handler.js' }, RequestHandler => {
  shimmer.wrap(RequestHandler.prototype, 'send', send => function (request, options, callback) {
    if (!startCh.hasSubscribers) {
      return send.apply(this, arguments)
    }
    const handler = this

    if (!isRequestValid(this, arguments, 3)) {
      return send.apply(this, arguments)
    }

    arguments[2] = function (...args) {
      startCtx = { hostname: handler.connection.address, port: handler.connection.port, ...startCtx }
      return connectCh.runStores(startCtx, callback, this, ...args)
    }

    return send.apply(this, arguments)
  })
  return RequestHandler
})

/**
 * @param {Record<string, unknown> & { error?: Error }} ctx
 * @param {Error} [error]
 */
function finish (ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.runStores(ctx, () => {})
}

/**
 * @param {Record<string, unknown> & { error?: Error }} ctx
 * @param {Parameters<typeof finishCh.runStores>[1]} callback
 */
function wrapCallback (ctx, callback) {
  return shimmer.wrapCallback(callback, callback => function (err) {
    if (err) {
      ctx.error = err
      errorCh.publish(ctx)
    }
    return finishCh.runStores(
      ctx, /** @type {Parameters<typeof finishCh.runStores>[1]} */ (callback), this, ...arguments
    )
  })
}

function isRequestValid (exec, args, length) {
  return !!exec && args.length === length && typeof args[length - 1] === 'function'
}
