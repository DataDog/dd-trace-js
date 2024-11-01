'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

const invokeTracingChannel = tracingChannel('apm:langchain:invoke')

function wrapLangChainPromise (fn, module, type, namespace = []) {
  return function () {
    if (!invokeTracingChannel.start.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const resource = [...(this.lc_namespace || namespace), module, this.constructor.name].join('.')

    const ctx = {
      args: arguments,
      instance: this,
      type,
      resource
    }

    return invokeTracingChannel.tracePromise(fn, ctx, this, ...arguments)
  }
}

addHook({ name: '@langchain/core', file: 'dist/runnables/base.cjs', versions: ['>=0.1'] }, exports => {
  const RunnableSequence = exports.RunnableSequence
  shimmer.wrap(RunnableSequence.prototype, 'invoke', invoke => wrapLangChainPromise(invoke, 'base', 'chain'))
  return exports
})

addHook({ name: '@langchain/core', file: 'dist/language_models/chat_models.cjs', versions: ['>=0.1'] }, exports => {
  const BaseChatModel = exports.BaseChatModel
  shimmer.wrap(
    BaseChatModel.prototype,
    'generate',
    generate => wrapLangChainPromise(generate, 'chat_model', 'chat_model')
  )
  return exports
})

addHook({ name: '@langchain/core', filePattern: 'dist/language_models/llms.cjs', versions: ['>=0.1'] }, exports => {
  const BaseLLM = exports.BaseLLM
  shimmer.wrap(BaseLLM.prototype, 'generate', generate => wrapLangChainPromise(generate, 'llm', 'llm'))
  return exports
})

addHook({ name: '@langchain/openai', file: 'dist/embeddings.cjs', versions: ['>=0.1'] }, exports => {
  const OpenAIEmbeddings = exports.OpenAIEmbeddings
  const namespace = ['langchain_openai']
  shimmer.wrap(OpenAIEmbeddings.prototype, 'embedDocuments', embedDocuments =>
    wrapLangChainPromise(embedDocuments, 'embeddings.base', 'embedding', namespace)
  )
  shimmer.wrap(OpenAIEmbeddings.prototype, 'embedQuery', embedQuery =>
    wrapLangChainPromise(embedQuery, 'embeddings.base', 'embedding', namespace)
  )
  return exports
})
