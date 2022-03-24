'use strict'

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http:server:request:start')
const endServerCh = channel('apm:http:server:request:end')
const errorServerCh = channel('apm:http:server:request:error')
const asyncEndServerCh = channel('apm:http:server:request:async-end')

addHook({ name: 'https' }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

addHook({ name: 'http' }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

function wrapResponseEmit (emit) {
  return function (eventName, event) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'finish') {
      asyncEndServerCh.publish({ req: this.req })
    }

    return emit.apply(this, arguments)
  }
}
function wrapEmit (emit) {
  return function (eventName, req, res) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'request') {
      res.req = req
      startServerCh.publish({ req, res })

      try {
        return emit.apply(this, arguments)
      } catch (err) {
        errorServerCh.publish(err)

        throw err
      } finally {
        endServerCh.publish(undefined)
      }
    }
    return emit.apply(this, arguments)
  }
}
