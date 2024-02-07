const {
  addHook,
  channel
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const executeStartCh = channel('apm:apollo:execute:start')
const executeEndCh = channel('apm:apollo:execute:end')
const executeErrorCh = channel('apm:apollo:execute:error')

const executeAsyncStartChannel = channel('apm:apollo:execute:asyncStart')
const executeAsyncEndChannel = channel('apm:apollo:execute:asyncEnd')

function wrapExecuteQueryPlan (executeQueryPlan) {
  return function wrappedExecuteQueryPlan (...args) {
    const ctx = {}
    return executeStartCh.runStores(ctx, () => {
      try {
        const result = executeQueryPlan.apply(this, args)
        if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
          executeAsyncStartChannel.runStores(ctx, () => {
            try {
              return result
            } catch (e) {
              ctx.error = e
              executeErrorCh.publish(ctx)
            } finally {
              executeAsyncEndChannel.publish(ctx)
            }
          })
        }

        return result
      } catch (e) {
        ctx.error = e
        executeErrorCh.publish(ctx)
      } finally {
        executeEndCh.publish(ctx)
      }
    })
  }
}

const postStartCh = channel('apm:apollo:postprocessing:start')
const postEndCh = channel('apm:apollo:postprocessing:end')
const postErrorCh = channel('apm:apollo:postprocessing:error')

const postAsyncStartChannel = channel('apm:apollo:postprocessing:asyncStart')
const postAsyncEndChannel = channel('apm:apollo:postprocessing:asyncEnd')

function wrapComputeResponse (computeResponse) {
  return function wrappedComputeResponse (...args) {
    const ctx = {}
    return postStartCh.runStores(ctx, () => {
      try {
        const result = computeResponse.apply(this, args)
        if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
          postAsyncStartChannel.runStores(ctx, () => {
            try {
              return result
            } catch (e) {
              ctx.error = e
              postErrorCh.publish(ctx)
            } finally {
              postAsyncEndChannel.publish(ctx)
            }
          })
        }

        return result
      } catch (e) {
        ctx.error = e
        postErrorCh.publish(ctx)
      } finally {
        postEndCh.publish(ctx)
      }
    })
  }
}

addHook({ name: '@apollo/gateway', file: 'dist/index.js', versions: ['2'] }, (gateway) => {
  return gateway
})

addHook({ name: '@apollo/gateway', file: 'dist/executeQueryPlan.js', versions: ['2'] }, (executeQueryPlan) => {
  return shimmer.wrap(executeQueryPlan, 'executeQueryPlan', wrapExecuteQueryPlan)
})

addHook({ name: '@apollo/gateway', file: 'dist/resultShaping.js', versions: ['2'] }, (computeResponse) => {
  return shimmer.wrap(computeResponse, 'computeResponse', wrapComputeResponse)
})
