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

const methodsOptionalArgs = new Set(['findOneAndUpdate'])

function getFilters (args, methodName) {
  const [arg0, arg1] = args

  const filters = arg0 !== null && typeof arg0 === 'object' ? [arg0] : []

  if (arg1 !== null && typeof arg1 === 'object' && methodsOptionalArgs.has(methodName)) {
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
      return function (...args) {
        if (prepareCh.hasSubscribers) {
          const filters = getFilters(args, methodName)
          if (filters?.length) {
            prepareCh.publish({ filters })
          }
        }

        return method.apply(this, args)
      }
    })
  }

  shimmer.wrap(Query.prototype, 'exec', originalExec => {
    return function wrappedExec (...args) {
      return tracingCh.tracePromise(originalExec, {}, this, args)
    }
  })

  return Query
})
