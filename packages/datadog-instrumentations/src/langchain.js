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

  addHook({ name: '@langchain/core', file: `dist/embeddings.${extension}`, versions: ['>=0.1'] }, exports => {
    // we cannot patch the prototype of the Embeddings class directly
    // this is because the "abstract class Embeddings" is transpiled from TypeScript to not include abstract functions
    // thus, we patch the exported class directly instead instead.

    shimmer.wrap(exports, 'Embeddings', Embeddings => {
      return class extends Embeddings {
        constructor (...args) {
          super(...args)

          const namespace = ['langchain', 'embeddings']

          // when originally implemented, we only wrapped OpenAI embeddings
          // these embeddings had the resource name of `langchain.embeddings.openai.OpenAIEmbeddings`
          // we need to make sure `openai` is appended to the resource name until a new tracer major version
          if (this.constructor.name === 'OpenAIEmbeddings') {
            namespace.push('openai')
          }

          shimmer.wrap(this, 'embedQuery', embedQuery => wrapLangChainPromise(embedQuery, 'embedding', namespace))
          shimmer.wrap(this, 'embedDocuments',
            embedDocuments => wrapLangChainPromise(embedDocuments, 'embedding', namespace))
        }

        static [Symbol.hasInstance] (instance) {
          return instance instanceof Embeddings
        }
      }
    })

    return exports
  })
}
