'use strict'
const { addHook } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel

function wrap (obj, name, channelName, namespace) {
  const channel = tracingChannel(channelName)
  shimmer.wrap(obj, name, function (original) {
    return function () {
      if (!channel.start.hasSubscribers) {
        return original.apply(this, arguments)
      }
      const ctx = { self: this, arguments }
      if (namespace) {
        ctx.namespace = namespace
      }
      return channel.tracePromise(original, ctx, this, ...arguments)
    }
  })
}

// langchain compiles into ESM and CommonJS, with ESM being the default and landing in the `.js` files
// however, CommonJS ends up in `cjs` files, and are required under the hood with `.cjs` files
// we patch each separately and explicitly to match against exports only once, and not rely on file regex matching
const extensions = ['js', 'cjs']

for (const extension of extensions) {
  addHook({ name: '@langchain/core', file: `dist/runnables/base.${extension}`, versions: ['>=0.1'] }, exports => {
    if (extension === 'cjs') {
      wrap(exports.RunnableSequence.prototype, 'invoke', 'orchestrion:@langchain/core:RunnableSequence_invoke')
      wrap(exports.RunnableSequence.prototype, 'batch', 'orchestrion:@langchain/core:RunnableSequence_batch')
    }
    return exports
  })

  addHook({
    name: '@langchain/core',
    file: `dist/language_models/chat_models.${extension}`,
    versions: ['>=0.1']
  }, exports => {
    if (extension === 'cjs') {
      wrap(exports.BaseChatModel.prototype, 'generate', 'orchestrion:@langchain/core:BaseChatModel_generate')
    }
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/language_models/llms.${extension}`, versions: ['>=0.1'] }, exports => {
    if (extension === 'cjs') {
      wrap(exports.BaseLLM.prototype, 'generate', 'orchestrion:@langchain/core:BaseLLM_generate')
    }
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/tools/index.${extension}`, versions: ['>=0.1'] }, exports => {
    if (extension === 'cjs') {
      wrap(exports.StructuredTool.prototype, 'invoke', 'orchestrion:@langchain/core:Tool_invoke')
    }
    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/vectorstores.${extension}`, versions: ['>=0.1'] }, exports => {
    if (extension === 'cjs') {
      wrap(
        exports.VectorStore.prototype, 'similaritySearch', 'orchestrion:@langchain/core:VectorStore_similaritySearch'
      )
      wrap(
        exports.VectorStore.prototype, 'similaritySearchWithScore',
        'orchestrion:@langchain/core:VectorStore_similaritySearchWithScore'
      )
    }

    return exports
  })

  addHook({ name: '@langchain/core', file: `dist/embeddings.${extension}`, versions: ['>=0.1'] }, exports => {
    if (extension === 'cjs') {
      shimmer.wrap(exports, 'Embeddings', Embeddings => {
        return class extends Embeddings {
          constructor (...args) {
            super(...args)

            const namespace = ['langchain', 'embeddings']

            if (this.constructor.name === 'OpenAIEmbeddings') {
              namespace.push('openai')
            }

            wrap(this, 'embedQuery', 'apm:@langchain/core:Embeddings_embedQuery', namespace)
            wrap(this, 'embedDocuments', 'apm:@langchain/core:Embeddings_embedDocuments', namespace)
          }
        }
      })
    } else {
      const channel = tracingChannel('orchestrion:@langchain/core:Embeddings_constructor')
      channel.subscribe({
        end (ctx) {
          const { self } = ctx
          const namespace = ['langchain', 'embeddings']

          if (self.constructor.name === 'OpenAIEmbeddings') {
            namespace.push('openai')
          }

          wrap(self, 'embedQuery', 'apm:@langchain/core:Embeddings_embedQuery', namespace)
          wrap(self, 'embedDocuments', 'apm:@langchain/core:Embeddings_embedDocuments', namespace)
        }
      })
    }
    return exports
  })
}
