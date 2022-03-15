'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:cassandra:query:start')
const asyncEndCh = channel('apm:cassandra:query:async-end')
const endCh = channel('apm:cassandra:query:end')
const errorCh = channel('apm:cassandra:query:error')
const addConnectionCh = channel(`apm:cassandra:query:addConnection`)

addHook({ name: 'cassandra-driver', versions: ['>=3.0.0'] }, cassandra => {
  shimmer.wrap(cassandra.Client.prototype, 'batch', batch => function (queries, options, callback) {
    if (!startCh.hasSubscribers) {
      return batch.apply(this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    startCh.publish({ keyspace: this.keyspace, query: queries })

    const lastIndex = arguments.length - 1
    let cb = arguments[lastIndex]

    if (typeof cb === 'function') {
      cb = asyncResource.bind(cb)
      arguments[lastIndex] = wrapCallback(asyncEndCh, errorCh, cb)
    }

    try {
      const res = batch.apply(this, arguments)
      if (typeof res === 'function' || !res) {
        return wrapCallback(asyncEndCh, errorCh, res)
      } else {
        const promiseAsyncResource = new AsyncResource('bound-anonymous-fn')
        return res.then(
          promiseAsyncResource.bind(() => finish(asyncEndCh, errorCh)),
          promiseAsyncResource.bind(err => finish(asyncEndCh, errorCh, err))
        )
      }
    } catch (e) {
      finish(asyncEndCh, errorCh, e)
      throw e
    } finally {
      endCh.publish(undefined)
    }
  })
  return cassandra
})

addHook({ name: 'cassandra-driver', versions: ['>=4.4'] }, cassandra => {
  shimmer.wrap(cassandra.Client.prototype, '_execute', _execute => function (query, params, execOptions, callback) {
    if (!startCh.hasSubscribers) {
      return _execute.apply(this, arguments)
    }
    startCh.publish({ keyspace: this.keyspace, query })
    const promise = _execute.apply(this, arguments)

    const promiseAsyncResource = new AsyncResource('bound-anonymous-fn')

    promise.then(
      promiseAsyncResource.bind(() => finish(asyncEndCh, errorCh)),
      promiseAsyncResource.bind(err => finish(asyncEndCh, errorCh, err))
    )
    endCh.publish(undefined)
    return promise
  })
  return cassandra
})

addHook({ name: 'cassandra-driver', versions: ['3 - 4.3'] }, cassandra => {
  shimmer.wrap(cassandra.Client.prototype, '_innerExecute', _innerExecute =>
    function (query, params, execOptions, callback) {
      if (!startCh.hasSubscribers) {
        return _innerExecute.apply(this, arguments)
      }
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      const isValid = (args) => {
        return args.length === 4 || typeof args[3] === 'function'
      }

      if (!isValid(arguments)) {
        return _innerExecute.apply(this, arguments)
      }

      startCh.publish({ keyspace: this.keyspace, query })

      const lastIndex = arguments.length - 1
      let cb = arguments[lastIndex]

      if (typeof cb === 'function') {
        cb = asyncResource.bind(cb)
        arguments[lastIndex] = wrapCallback(asyncEndCh, errorCh, cb)
      }

      try {
        return _innerExecute.apply(this, arguments)
      } catch (e) {
        finish(asyncEndCh, errorCh, e)
        throw e
      } finally {
        endCh.publish(undefined)
      }
    }
  )
  return cassandra
})

addHook({ name: 'cassandra-driver', versions: ['>=3.3'], file: 'lib/request-execution.js' }, RequestExecution => {
  shimmer.wrap(RequestExecution.prototype, '_sendOnConnection', _sendOnConnection => function () {
    if (!startCh.hasSubscribers) {
      return _sendOnConnection.apply(this, arguments)
    }
    addConnectionCh.publish({ address: this._connection.address, port: this._connection.port })
    return _sendOnConnection.apply(this, arguments)
  })
  return RequestExecution
})

addHook({ name: 'cassandra-driver', versions: ['3.3 - 4.3'], file: 'lib/request-execution.js' }, RequestExecution => {
  shimmer.wrap(RequestExecution.prototype, 'start', start => function (getHostCallback) {
    if (!startCh.hasSubscribers) {
      return getHostCallback.apply(this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const execution = this

    if (!isRequestValid(this, arguments, 1)) {
      return start.apply(this, arguments)
    }

    getHostCallback = asyncResource.bind(getHostCallback)

    arguments[0] = AsyncResource.bind(function () {
      addConnectionCh.publish({ address: execution._connection.address, port: execution._connection.port })
      return getHostCallback.apply(this, arguments)
    })

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
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    callback = asyncResource.bind(callback)

    arguments[2] = AsyncResource.bind(function () {
      addConnectionCh.publish({ address: handler.connection.address, port: handler.connection.port })
      return callback.apply(this, arguments)
    })

    return send.apply(this, arguments)
  })
  return RequestHandler
})

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}

function wrapCallback (asyncEndCh, errorCh, callback) {
  return AsyncResource.bind(function (err) {
    finish(asyncEndCh, errorCh, err)
    if (callback) {
      return callback.apply(this, arguments)
    }
  })
}

function isRequestValid (exec, args, length) {
  if (!exec) return false
  if (args.length !== length || typeof args[length - 1] !== 'function') return false

  return true
}
