'use strict'

const files = [
  'decorator/dist/index.cjs',
  'decorator/dist/index.js',
  'embeddings/dist/index.cjs',
  'embeddings/dist/index.js',
  'retriever/dist/index.cjs',
  'retriever/dist/index.js',
  'query-engine/dist/index.cjs',
  'query-engine/dist/index.js',
  'chat-engine/dist/index.cjs',
  'chat-engine/dist/index.js',
  'response-synthesizers/dist/index.cjs',
  'response-synthesizers/dist/index.js',
]

const moduleConfig = filePath => ({
  name: '@llamaindex/core',
  versionRange: '>=0.6.0',
  filePath,
})

const method = (filePath, className, methodName, channelName) => ({
  module: moduleConfig(filePath),
  functionQuery: { className, methodName, kind: 'Async' },
  channelName,
})

module.exports = [
  ...files.slice(0, 2).map(filePath => ({
    module: moduleConfig(filePath),
    functionQuery: {
      expressionName: 'withLLMEvent',
      kind: 'Async',
      returnKind: 'AsyncIterator',
    },
    channelName: 'LLM_chat',
  })),
  ...files.slice(2, 4).map(filePath => method(
    filePath, 'BaseEmbedding', 'getQueryEmbedding', 'BaseEmbedding_getQueryEmbedding'
  )),
  ...files.slice(2, 4).map(filePath => method(
    filePath, 'BaseEmbedding', 'getTextEmbeddingsBatch', 'BaseEmbedding_getTextEmbeddingsBatch'
  )),
  ...files.slice(4, 6).map(filePath => method(filePath, 'BaseRetriever', 'retrieve', 'BaseRetriever_retrieve')),
  ...files.slice(6, 8).map(filePath => method(filePath, 'BaseQueryEngine', 'query', 'BaseQueryEngine_query')),
  ...files.slice(8, 10).flatMap(filePath => [
    method(filePath, 'ContextChatEngine', 'chat', 'ContextChatEngine_chat'),
    method(filePath, 'SimpleChatEngine', 'chat', 'SimpleChatEngine_chat'),
  ]),
  ...files.slice(10, 12).map(filePath => method(
    filePath, 'BaseSynthesizer', 'synthesize', 'BaseSynthesizer_synthesize'
  )),
]
