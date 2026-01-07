'use strict'

module.exports = [
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/runnables/base.cjs'
    },
    functionQuery: {
      methodName: 'invoke',
      kind: 'Async',
      className: 'RunnableSequence'
    },
    channelName: 'RunnableSequence_invoke'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/runnables/base.cjs'
    },
    functionQuery: {
      methodName: 'batch',
      kind: 'Async',
      className: 'RunnableSequence'
    },
    channelName: 'RunnableSequence_batch'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/language_models/chat_models.cjs'
    },
    functionQuery: {
      methodName: 'generate',
      kind: 'Async',
      className: 'BaseChatModel'
    },
    channelName: 'BaseChatModel_generate'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/language_models/llms.cjs'
    },
    functionQuery: {
      methodName: 'generate',
      kind: 'Async'
    },
    channelName: 'BaseLLM_generate'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/embeddings.cjs'
    },
    functionQuery: {
      methodName: 'embedQuery',
      kind: 'Async',
      className: 'Embeddings'
    },
    channelName: 'Embeddings_embedQuery'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/embeddings.cjs'
    },
    functionQuery: {
      methodName: 'embedDocuments',
      kind: 'Async',
      className: 'Embeddings'
    },
    channelName: 'Embeddings_embedDocuments'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/tools/index.cjs'
    },
    functionQuery: {
      methodName: 'invoke',
      kind: 'Async',
      className: 'StructuredTool'
    },
    channelName: 'Tool_invoke'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/vectorstores.cjs'
    },
    functionQuery: {
      methodName: 'similaritySearch',
      kind: 'Async',
      className: 'VectorStore'
    },
    channelName: 'VectorStore_similaritySearch'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/vectorstores.cjs'
    },
    functionQuery: {
      methodName: 'similaritySearchWithScore',
      kind: 'Async',
      className: 'VectorStore'
    },
    channelName: 'VectorStore_similaritySearchWithScore'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/runnables/base.js'
    },
    functionQuery: {
      methodName: 'invoke',
      kind: 'Async',
      className: 'RunnableSequence'
    },
    channelName: 'RunnableSequence_invoke'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/runnables/base.js'
    },
    functionQuery: {
      methodName: 'batch',
      kind: 'Async',
      className: 'RunnableSequence'
    },
    channelName: 'RunnableSequence_batch'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/language_models/chat_models.js'
    },
    functionQuery: {
      methodName: 'generate',
      kind: 'Async',
      className: 'BaseChatModel'
    },
    channelName: 'BaseChatModel_generate'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/language_models/llms.js'
    },
    functionQuery: {
      methodName: 'generate',
      kind: 'Async'
    },
    channelName: 'BaseLLM_generate'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/embeddings.js'
    },
    functionQuery: {
      methodName: 'embedQuery',
      kind: 'Async',
      className: 'Embeddings'
    },
    channelName: 'Embeddings_embedQuery'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/embeddings.js'
    },
    functionQuery: {
      methodName: 'embedDocuments',
      kind: 'Async',
      className: 'Embeddings'
    },
    channelName: 'Embeddings_embedDocuments'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/tools/index.js'
    },
    functionQuery: {
      methodName: 'invoke',
      kind: 'Async',
      className: 'StructuredTool'
    },
    channelName: 'Tool_invoke'
  },
  {
    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/vectorstores.js'
    },
    functionQuery: {
      methodName: 'similaritySearch',
      kind: 'Async',
      className: 'VectorStore'
    },
    channelName: 'VectorStore_similaritySearch'
  },
  {

    module: {
      name: '@langchain/core',
      versionRange: '>=0.1',
      filePath: 'dist/vectorstores.js'
    },
    functionQuery: {
      methodName: 'similaritySearchWithScore',
      kind: 'Async',
      className: 'VectorStore'
    },
    channelName: 'VectorStore_similaritySearchWithScore'
  }
]
