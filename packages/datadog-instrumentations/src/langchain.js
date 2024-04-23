'use strict'

const {
  channel,
  addHook, AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const invokeFinishCh = channel('datadog:langchain:invoke:finish')
const outputParseFinishCh = channel('datadog:langchain:outputparse:finish')

addHook({ name: 'langchain', file: 'dist/chains/base.cjs', versions: ['>=0.1.0'] }, exports => {
  shimmer.wrap(exports.BaseChain.prototype, 'invoke', fn => function (input) {
    const result = fn.apply(this, arguments)
    if (invokeFinishCh.hasSubscribers) {
      // const callbackResource = new AsyncResource('bound-anonymous-fn')
      return result.then(output => {
        const publishData = {
          input: input.input,
          output
        }

        invokeFinishCh.publish(publishData)

        return publishData.output
        // return callbackResource.runInAsyncScope(() => {
        // })
      })
    }

    return result
  })
  return exports
})

addHook({ name: 'langchain', file: 'dist/agents/mrkl/outputParser.cjs', versions: ['>=0.1.0'] }, exports => {
  shimmer.wrap(exports.ZeroShotAgentOutputParser.prototype, 'parse', fn => function (input) {
    const result = fn.apply(this, arguments)
    if (outputParseFinishCh.hasSubscribers) {
      const callbackResource = new AsyncResource('bound-anonymous-fn')
      return result.then(output => {
        return callbackResource.runInAsyncScope(() => {
          const publishData = {
            input,
            output
          }

          outputParseFinishCh.publish(publishData)

          return publishData.output
        })
      })
    }

    return result
  })

  return exports
})
