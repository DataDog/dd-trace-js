module.exports = `
version: 1
dc_module: dc-polyfill
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
  - module_name: "@vitest/runner"
    version_range: ">=3.0.0"
    file_path: dist/index.js
    function_query:
      name: startTests
      type: method
      kind: async
    operator: tracePromise
    channel_name: "Vitest_startTests"
  - module_name: "vitest"
    version_range: ">=3.0.0"
    file_path: dist/chunks/cac.CeVHgzve.js
    function_query:
      name: createCLI
      type: method
      kind: sync
    operator: traceSync
    channel_name: "Vitest_createCLI"
`
