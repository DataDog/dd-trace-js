'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'tedious', versions: ['>=1.0.0'] }, tedious => {
  const startCh = channel('apm:tedious:request:start')
  const finishCh = channel('apm:tedious:request:finish')
  const errorCh = channel('apm:tedious:request:error')
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
