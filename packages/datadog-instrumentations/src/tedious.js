'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'tedious', versions: [ '>=1.0.0' ] }, tedious => {
  const startCh = channel('apm:tedious:request:start')
  const asyncEndCh = channel('apm:tedious:request:async-end')
  const endCh = channel('apm:tedious:request:end')
  const errorCh = channel('apm:tedious:request:error')
  shimmer.wrap(tedious.Connection.prototype, 'makeRequest', makeRequest => function (request) {
    if (!startCh.hasSubscribers) {
      return request.apply(this, arguments)
    }

    const queryOrProcedure = getQueryOrProcedure(request)

    if (!queryOrProcedure) {
      return makeRequest.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const connectionConfig = this.config

    startCh.publish({ queryOrProcedure, connectionConfig })

    const cb = asyncResource.bind(request.callback, request)
    request.callback = AsyncResource.bind(function (error) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(undefined)

      return cb.apply(this, arguments)
    }, null, request)

    try {
      return makeRequest.apply(this, arguments)
    } catch (error) {
      errorCh.publish(error)

      throw error
    } finally {
      endCh.publish(undefined)
    }
  })

  return tedious
})

function getQueryOrProcedure (request) {
  if (!request.parameters) return

  const statement = request.parametersByName.statement || request.parametersByName.stmt

  if (!statement) {
    return request.sqlTextOrProcedure
  }

  return statement.value
}
