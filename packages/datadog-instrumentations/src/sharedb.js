'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

/**
 * @description The enum values in this map are not exposed from ShareDB, so the keys are hard-coded here.
 * The values were derived from: https://github.com/share/sharedb/blob/master/lib/client/connection.js#L196
 */
const READABLE_ACTION_NAMES = {
  hs: 'handshake',
  qf: 'query-fetch',
  qs: 'query-subscribe',
  qu: 'query-unsubscribe',
  bf: 'bulk-fetch',
  bs: 'bulk-subscribe',
  bu: 'bulk-unsubscribe',
  f: 'fetch',
  s: 'subscribe',
  u: 'unsubscribe',
  op: 'op',
  nf: 'snapshot-fetch',
  nt: 'snapshot-fetch-by-ts',
  p: 'presence-broadcast',
  pr: 'presence-request',
  ps: 'presence-subscribe',
  pu: 'presence-unsubscribe'
}

addHook({ name: 'sharedb', versions: ['>=1'], file: 'lib/agent.js' }, Agent => {
  const startCh = channel('apm:sharedb:request:start')
  const asyncEndCh = channel('apm:sharedb:request:async-end')
  const endCh = channel('apm:sharedb:request:end')
  const errorCh = channel('apm:sharedb:request:error')

  shimmer.wrap(Agent.prototype, '_handleMessage', origHandleMessageFn => function (request, callback) {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const action = request.a

    const actionName = getReadableActionName(action)

    startCh.publish({ actionName, request })

    callback = asyncResource.bind(callback)

    arguments[1] = AsyncResource.bind(function (error, res) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish({ request, res })

      return callback.apply(this, arguments)
    })

    try {
      return origHandleMessageFn.apply(this, arguments)
    } catch (error) {
      errorCh.publish(error)

      throw error
    } finally {
      endCh.publish(undefined)
    }
  })
  return Agent
})

function getReadableActionName (action) {
  const actionName = READABLE_ACTION_NAMES[action]
  if (actionName === undefined) {
    return action
  }
  return actionName
}
