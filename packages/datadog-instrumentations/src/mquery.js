'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const prepareCh = channel('datadog:mquery:filter:prepare')
const tracingCh = dc.tracingChannel('datadog:mquery:filter')

const methods = [
  'find',
  'findOne',
  'findOneAndRemove',
  'findOneAndDelete',
  'count',
  'distinct',
  'where',
]

const methodsOptionalArgs = ['findOneAndUpdate']

function getFilters (args, methodName) {
  const [arg0, arg1] = args

  const filters = arg0 !== null && typeof arg0 === 'object' ? [arg0] : []

  if (arg1 !== null && typeof arg1 === 'object' && methodsOptionalArgs.includes(methodName)) {
    filters.push(arg1)
  }

  return filters
}

addHook({
  name: 'mquery',
  versions: ['>=5.0.0'],
}, Query => {
  for (const methodName of [...methods, ...methodsOptionalArgs]) {
    if (!(methodName in Query.prototype)) continue

    shimmer.wrap(Query.prototype, methodName, method => {
      return function () {
        if (prepareCh.hasSubscribers) {
          const filters = getFilters(arguments, methodName)
          if (filters?.length) {
            prepareCh.publish({ filters })
          }
        }

        return method.apply(this, arguments)
      }
    })
  }

  // TEMP DEBUG: verify whether the wrapped exec is actually invoked in Node 18 CI.
  // eslint-disable-next-line no-console
  console.log('[MQUERY DBG] shimmer.wrap exec applied hasExec=%s typeof=%s',
    'exec' in Query.prototype, typeof Query.prototype.exec)
  shimmer.wrap(Query.prototype, 'exec', originalExec => {
    return function wrappedExec () {
      // eslint-disable-next-line no-console
      console.log('[MQUERY DBG] wrappedExec called op=%s hasTracingStartSubs=%s hasPrepareSubs=%s',
        this?.op, tracingCh.start?.hasSubscribers, prepareCh.hasSubscribers)
      return tracingCh.tracePromise(originalExec, {}, this, arguments)
    }
  })

  return Query
})
