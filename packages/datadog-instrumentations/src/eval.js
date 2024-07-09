'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('dc-polyfill')

if (globalThis.eval) {
  const evalStartChannel = channel('datadog:eval:start')

  shimmer.wrap(globalThis, 'eval', function wrapEval (originalEval) {
    return function wrappedEval (script) {
      if (!evalStartChannel.hasSubscribers) {
        return originalEval.apply(this, arguments)
      }

      evalStartChannel.publish({
        script
      })

      return originalEval.apply(this, arguments)
    }
  })
}
