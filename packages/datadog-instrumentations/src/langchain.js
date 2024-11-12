'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

const invokeTracingChannel = tracingChannel('apm:langchain:invoke')

function wrapLangChainPromise (fn, type, namespace = []) {
  return function () {
    if (!invokeTracingChannel.start.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    // Runnable interfaces have an `lc_namespace` property
    const ns = this.lc_namespace || namespace
    const resource = [...ns, this.constructor.name].join('.')

    const ctx = {
      args: arguments,
      instance: this,
      type,
      resource
    }

    return invokeTracingChannel.tracePromise(fn, ctx, this, ...arguments)
  }
}

// langchain compiles into ESM and CommonJS, with ESM being the default and landing in the `.js` files
// however, CommonJS ends up in `cjs` files, and are required under the hood with `.cjs` files
// we patch each separately and explicitly to match against exports only once, and not rely on file regex matching
const extensions = ['js', 'cjs']

for (const extension of extensions) {
  addHook({ name: '@langchain/core', file: `dist/runnables/base.${extension}`, versions: ['>=0.1'] }, exports => {
    const RunnableSequence = exports.RunnableSequence
    shimmer.wrap(RunnableSequence.prototype, 'invoke', invoke => wrapLangChainPromise(invoke, 'chain'))
    shimmer.wrap(RunnableSequence.prototype, 'batch', batch => wrapLangChainPromise(batch, 'chain'))
    return exports
  })

  addHook({
    name: '@langchain/core',
    file: `dist/language_models/chat_models.${extension}`,
    versions: ['>=0.1']
  }, exports => {
    const BaseChatModel = exports.BaseChatModel
    shimmer.wrap(
      BaseChatModel.prototype,
      'generate',
      generate => wrapLangChainPromise(generate, 'chat_model')
    )
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/language_models/llms.${extension}`, versions: ['>=0.1'] }, exports => {
    const BaseLLM = exports.BaseLLM
    shimmer.wrap(BaseLLM.prototype, 'generate', generate => wrapLangChainPromise(generate, 'llm'))
    return exports
  })

  addHook({ name: '@langchain/openai', file: `dist/embeddings.${extension}`, versions: ['>=0.1'] }, exports => {
    const OpenAIEmbeddings = exports.OpenAIEmbeddings

    // OpenAI (and Embeddings in general) do not define an lc_namespace
    const namespace = ['langchain', 'embeddings', 'openai']
    shimmer.wrap(OpenAIEmbeddings.prototype, 'embedDocuments', embedDocuments =>
      wrapLangChainPromise(embedDocuments, 'embedding', namespace)
    )
    shimmer.wrap(OpenAIEmbeddings.prototype, 'embedQuery', embedQuery =>
      wrapLangChainPromise(embedQuery, 'embedding', namespace)
    )
    return exports
  })
}
