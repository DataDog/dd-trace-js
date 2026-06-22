'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
  AsyncResource,
} = require('./helpers/instrument')

// Listeners added to the BulkLoad row stream (`bulkLoad.getRowStream()`) by the caller would
// otherwise run in whatever async context emits the stream event, losing the span that was active
// when the listener was registered. Bind each registered listener to its registration context so
// `'finish'`/`'error'`/`'data'` handlers run in the caller's span. tedious' own internal listeners
// are attached before `getRowStream` returns, so only caller listeners are bound.
const ROW_STREAM_LISTENER_METHODS = ['addListener', 'on', 'once', 'prependListener', 'prependOnceListener']

function bindRowStreamListeners (rowStream) {
  for (const method of ROW_STREAM_LISTENER_METHODS) {
    shimmer.wrap(rowStream, method, register => function (eventName, listener) {
      if (typeof listener !== 'function') {
        return register.apply(this, arguments)
      }
      return register.call(this, eventName, AsyncResource.bind(listener))
    })
  }
  return rowStream
}

addHook({ name: 'tedious', versions: ['>=1.0.0'] }, tedious => {
  const startCh = channel('apm:tedious:request:start')
  const finishCh = channel('apm:tedious:request:finish')
  const errorCh = channel('apm:tedious:request:error')

  if (typeof tedious.BulkLoad?.prototype?.getRowStream === 'function') {
    shimmer.wrap(tedious.BulkLoad.prototype, 'getRowStream', getRowStream => function () {
      return bindRowStreamListeners(getRowStream.apply(this, arguments))
    })
  }

  shimmer.wrap(tedious.Connection.prototype, 'makeRequest', makeRequest => function (request) {
    if (!startCh.hasSubscribers) {
      return makeRequest.apply(this, arguments)
    }

    const [queryOrProcedure, queryParent, queryField] = getQueryOrProcedure(request)

    if (!queryOrProcedure) {
      return makeRequest.apply(this, arguments)
    }

    const connectionConfig = this.config
    const ctx = { queryOrProcedure, connectionConfig }

    return startCh.runStores(ctx, () => {
      queryParent[queryField] = ctx.sql

      const cb = request.callback
      request.callback = function (error, ...args) {
        if (error) {
          ctx.error = error
          errorCh.publish(ctx)
        }
        return finishCh.runStores(ctx, cb, this, error, ...args)
      }

      try {
        return makeRequest.apply(this, arguments)
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)

        throw error
      }
    })
  })

  return tedious
})

// returns [queryOrProcedure, parentObjectToSet, propertyNameToSet]
function getQueryOrProcedure (request) {
  if (!request.parameters) return [null]

  if (request.parametersByName.statement) {
    return [request.parametersByName.statement.value, request.parametersByName.statement, 'value']
  } else if (request.parametersByName.stmt) {
    return [request.parametersByName.stmt.value, request.parametersByName.stmt, 'value']
  }
  return [request.sqlTextOrProcedure, request, 'sqlTextOrProcedure']
}
