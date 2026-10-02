'use strict'

const VENDORED_DC_MODULE = 'dd-trace/vendor/dist/dc-polyfill'

function resolveDcPolyfill () {
  try {
    return require.resolve('../../../../vendor/dist/dc-polyfill')
  } catch {
    try {
      // A bundled tracer no longer has this file's source-relative layout,
      // but can still resolve the installed package that owns the bundle.
      return require.resolve(VENDORED_DC_MODULE)
    } catch {
      return 'node:diagnostics_channel'
    }
  }
}

module.exports = `
version: 1
dc_module: ${JSON.stringify(resolveDcPolyfill())}
instrumentations:
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/runnables/base.js
    function_query:
      name: invoke
      type: method
      kind: async
      class: RunnableSequence
    operator: tracePromise
    channel_name: "RunnableSequence_invoke"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/runnables/base.js
    function_query:
      name: batch
      type: method
      kind: async
      class: RunnableSequence
    operator: tracePromise
    channel_name: "RunnableSequence_batch"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/language_models/chat_models.js
    function_query:
      name: generate
      type: method
      kind: async
      class: BaseChatModel
    operator: tracePromise
    channel_name: "BaseChatModel_generate"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/language_models/llms.js
    function_query:
      name: generate
      type: method
      kind: async
    operator: tracePromise
    channel_name: "BaseLLM_generate"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/embeddings.js
    function_query:
      name: constructor
      type: method
      kind: sync
      class: Embeddings
    operator: traceSync
    channel_name: "Embeddings_constructor"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/tools/index.js
    function_query:
      name: invoke
      type: method
      kind: async
      class: StructuredTool
    operator: tracePromise
    channel_name: "Tool_invoke"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/vectorstores.js
    function_query:
      name: similaritySearch
      type: method
      kind: async
      class: VectorStore
    operator: tracePromise
    channel_name: "VectorStore_similaritySearch"
  - module_name: "@langchain/core"
    version_range: ">=0.1.0"
    file_path: dist/vectorstores.js
    function_query:
      name: similaritySearchWithScore
      type: method
      kind: async
      class: VectorStore
    operator: tracePromise
    channel_name: "VectorStore_similaritySearchWithScore"
`
