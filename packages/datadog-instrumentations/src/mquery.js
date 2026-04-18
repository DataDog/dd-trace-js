'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const prepareCh = channel('datadog:mquery:filter:prepare')
const tracingCh = dc.tracingChannel('datadog:mquery:filter')

// TEMP DEBUG: capture the channel identities at module-load time so we can compare in wrappedExec.
// eslint-disable-next-line no-console
console.log('[MQUERY DBG] module load nodeVersion=%s hasTracingChannel=%s tracingChType=%s startChType=%s ' +
  'tracingChHas=%s startChHas=%s ownHasSubsDesc=%s',
  process.versions.node,
  typeof dc.tracingChannel === 'function',
  tracingCh?.constructor?.name,
  tracingCh?.start?.constructor?.name,
  tracingCh?.hasSubscribers,
  tracingCh?.start?.hasSubscribers,
  !!Object.getOwnPropertyDescriptor(tracingCh?.start || {}, 'hasSubscribers'))

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
      // TEMP DEBUG: compare channel identity between tracingCh.start and dc.channel(...) at exec time
      // to detect tracingChannel sub-channel drift in CI.
      const chByName = dc.channel('tracing:datadog:mquery:filter:start')
      const chByTcStart = tracingCh.start
      // eslint-disable-next-line no-console
      console.log('[MQUERY DBG] wrappedExec op=%s hasTracingStartSubs=%s hasPrepareSubs=%s ' +
        'startIdentityEq=%s startSubsCount=%s byNameSubsCount=%s ownHasSubsDesc=%s byNameHasSubs=%s ' +
        'startWrapped=%s byNameWrapped=%s subName=%s unsubName=%s',
        this?.op,
        chByTcStart?.hasSubscribers,
        prepareCh.hasSubscribers,
        chByTcStart === chByName,
        chByTcStart?._subscribers?.length,
        chByName?._subscribers?.length,
        !!Object.getOwnPropertyDescriptor(chByTcStart || {}, 'hasSubscribers'),
        chByName?.hasSubscribers,
        !!chByTcStart?.__nosqlDbgWrapped,
        !!chByName?.__nosqlDbgWrapped,
        chByTcStart?.subscribe?.name,
        chByTcStart?.unsubscribe?.name)
      return tracingCh.tracePromise(originalExec, {}, this, arguments)
    }
  })

  return Query
})
