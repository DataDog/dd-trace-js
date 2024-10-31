'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

const invokeTracingChannel = tracingChannel('apm:langchain:invoke')

function wrapLangChainPromise (fn, module, type) {
  return function () {
    if (!invokeTracingChannel.start.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const resource = [...this.lc_namespace, module, this.constructor.name].join('.')

    const ctx = {
      args: arguments,
      instance: this,
      type,
      resource
    }

    return invokeTracingChannel.tracePromise(fn, ctx, this, ...arguments)
  }
}

addHook({ name: '@langchain/core', filePattern: 'dist/runnables/base.*', versions: ['>=0.1'] }, exports => {
  const RunnableSequence = exports.RunnableSequence
  shimmer.wrap(RunnableSequence.prototype, 'invoke', invoke => wrapLangChainPromise(invoke, 'base', 'chain'))
  return exports
})

addHook({ name: '@langchain/core', filePattern: 'dist/language_models/chat_model.*', versions: ['>=0.1'] }, exports => {
  const BaseChatModel = exports.BaseChatModel
  shimmer.wrap(
    BaseChatModel.prototype,
    'generate',
    generate => wrapLangChainPromise(generate, 'chat_model', 'chat_model')
  )
  return exports
})

addHook({ name: '@langchain/core', filePattern: 'dist/language_models/llm.*', versions: ['>=0.1'] }, exports => {
  const BaseLLM = exports.BaseLLM
  shimmer.wrap(BaseLLM.prototype, 'generate', generate => wrapLangChainPromise(generate, 'llm', 'llm'))
  return exports
})
