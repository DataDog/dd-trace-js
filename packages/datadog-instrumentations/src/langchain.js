'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

const invokeTracingChannel = tracingChannel('apm:langchain:invoke')

addHook({ name: '@langchain/core', filePattern: 'dist/runnables/base.*', versions: ['>=0.2'] }, exports => {
  const RunnableSequence = exports.RunnableSequence
  shimmer.wrap(RunnableSequence.prototype, 'invoke', invoke => function wrappedInvoke () {
    if (!invokeTracingChannel.start.hasSubscribers) {
      return invoke.apply(this, arguments)
    }

    const ctx = {
      args: arguments,
      instance: this,
      resource: 'langchain_core.runnables.base.RunnableSequence.invoke',
      type: 'chain'
    }

    return invokeTracingChannel.tracePromise(invoke, ctx, this, ...arguments)
  })
  return exports
})
