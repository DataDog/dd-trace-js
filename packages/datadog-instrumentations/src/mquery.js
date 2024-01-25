'use strict'

const dc = require('dc-polyfill')
const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const prepareCh = channel('datadog:mquery:filter:prepare')
const tracingCh = dc.tracingChannel('datadog:mquery:filter')

const methods = [
  'find',
  'findOne',
  'findOneAndRemove',
  'findOneAndDelete',
  'count',
  'distinct',
  'where'
]

const methodsOptionalArgs = ['findOneAndUpdate']

function getFilters (args, methodName) {
  const [arg0, arg1] = args

  const filters = arg0 && typeof arg0 === 'object' ? [arg0] : []

  if (arg1 && typeof arg1 === 'object' && methodsOptionalArgs.includes(methodName)) {
    filters.push(arg1)
  }

  return filters
}

addHook({
  name: 'mquery',
  versions: ['>=5.0.0']
}, Query => {
  [...methods, ...methodsOptionalArgs].forEach(methodName => {
    if (!(methodName in Query.prototype)) return

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
  })

  shimmer.wrap(Query.prototype, 'exec', originalExec => {
    return function wrappedExec () {
      return tracingCh.tracePromise(originalExec, {}, this, arguments)
    }
  })

  return Query
})
