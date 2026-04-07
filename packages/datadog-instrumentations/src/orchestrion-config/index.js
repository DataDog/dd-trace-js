'use strict'

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
  # ---------------------------------------------------------------------------
  # mariadb
  # ---------------------------------------------------------------------------
  # v3: Pool.getConnection (callback-based)
  # TODO: noCallbackFallback not yet supported in orchestrion-config (nodejs/orchestrion-js pending)
  - module_name: mariadb
    version_range: ">=3.4.1"
    file_path: lib/pool.js
    function_query:
      name: getConnection
      type: method
      kind: callback
      class: Pool
    operator: traceCallback
    channel_name: "Pool_getConnection"
  # v2: Connection constructor (sync — stash opts on instance as __ddConf)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: lib/connection.js
    function_query:
      name: Connection
      type: function
      kind: sync
    operator: traceSync
    channel_name: "v2Connection"
  # v2: PoolBase constructor (sync — stash opts on instance as __ddConf)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: lib/pool-base.js
    function_query:
      name: PoolBase
      type: function
      kind: sync
    operator: traceSync
    channel_name: "v2PoolBase"
  # v>=2.5.2 <3: _queryPromise (promise API — arrow fn assigned to this in constructor)
  - module_name: mariadb
    version_range: ">=2.5.2 <3"
    file_path: lib/connection.js
    function_query:
      object_name: this
      property_name: _queryPromise
      kind: async
    operator: tracePromise
    channel_name: "v2Connection_queryPromise"
  # v>=2.0.4 <=2.5.1: query (promise API — arrow fn assigned to this in constructor)
  - module_name: mariadb
    version_range: ">=2.0.4 <=2.5.1"
    file_path: lib/connection.js
    function_query:
      object_name: this
      property_name: query
      kind: async
    operator: tracePromise
    channel_name: "v2Connection_query"
  # v2: _queryCallback (callback API — arrow fn assigned to this in constructor)
  # TODO: noCallbackFallback not yet supported in orchestrion-config (nodejs/orchestrion-js pending)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: lib/connection.js
    function_query:
      object_name: this
      property_name: _queryCallback
      kind: callback
    operator: traceCallback
    channel_name: "v2Connection_queryCallback"
  # v2: pool getConnection (promise API — arrow fn assigned to this in constructor)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: lib/pool-base.js
    function_query:
      object_name: this
      property_name: getConnection
      kind: async
    operator: tracePromise
    channel_name: "v2PoolBase_getConnection"
  # v2: pool query (promise API — arrow fn assigned to this in constructor)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: lib/pool-base.js
    function_query:
      object_name: this
      property_name: query
      kind: async
    operator: tracePromise
    channel_name: "v2PoolBase_query"
  # v2: callback.js createPool/createConnection (sync — clear context before pool init)
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: callback.js
    function_query:
      name: createPool
      type: expression
      kind: sync
    operator: traceSync
    channel_name: "createPool"
  - module_name: mariadb
    version_range: ">=2.0.4 <3"
    file_path: callback.js
    function_query:
      name: createConnection
      type: expression
      kind: sync
    operator: traceSync
    channel_name: "createConnection"
  # v3: callback.js createPool/createConnection
  - module_name: mariadb
    version_range: ">=3"
    file_path: callback.js
    function_query:
      name: createPool
      type: expression
      kind: sync
    operator: traceSync
    channel_name: "createPool"
  - module_name: mariadb
    version_range: ">=3"
    file_path: callback.js
    function_query:
      name: createConnection
      type: expression
      kind: sync
    operator: traceSync
    channel_name: "createConnection"
  # v3: promise.js createPool/createConnection
  - module_name: mariadb
    version_range: ">=3"
    file_path: promise.js
    function_query:
      name: createConnection
      type: expression
      kind: async
    operator: tracePromise
    channel_name: "createConnection"
  - module_name: mariadb
    version_range: ">=3"
    file_path: promise.js
    function_query:
      name: createPool
      type: expression
      kind: sync
    operator: traceSync
    channel_name: "createPool"
  # v3: ConnectionCallback query/execute (callback-based)
  # TODO: noCallbackFallback not yet supported in orchestrion-config (nodejs/orchestrion-js pending)
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/connection-callback.js
    function_query:
      name: query
      type: method
      kind: callback
      class: ConnectionCallback
    operator: traceCallback
    channel_name: "ConnectionCallback_query"
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/connection-callback.js
    function_query:
      name: execute
      type: method
      kind: callback
      class: ConnectionCallback
    operator: traceCallback
    channel_name: "ConnectionCallback_execute"
  # v3: ConnectionPromise query/execute (promise-based)
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/connection-promise.js
    function_query:
      name: query
      type: method
      kind: async
      class: ConnectionPromise
    operator: tracePromise
    channel_name: "ConnectionPromise_query"
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/connection-promise.js
    function_query:
      name: execute
      type: method
      kind: async
      class: ConnectionPromise
    operator: tracePromise
    channel_name: "ConnectionPromise_execute"
  # v3: PoolCallback query/execute (callback-based)
  # TODO: noCallbackFallback not yet supported in orchestrion-config (nodejs/orchestrion-js pending)
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/pool-callback.js
    function_query:
      name: query
      type: method
      kind: callback
      class: PoolCallback
    operator: traceCallback
    channel_name: "PoolCallback_query"
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/pool-callback.js
    function_query:
      name: execute
      type: method
      kind: callback
      class: PoolCallback
    operator: traceCallback
    channel_name: "PoolCallback_execute"
  # v3: PoolPromise query/execute (promise-based)
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/pool-promise.js
    function_query:
      name: query
      type: method
      kind: async
      class: PoolPromise
    operator: tracePromise
    channel_name: "PoolPromise_query"
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/pool-promise.js
    function_query:
      name: execute
      type: method
      kind: async
      class: PoolPromise
    operator: tracePromise
    channel_name: "PoolPromise_execute"
  # v3: PrepareResultPacket.execute (callback-based, used via PrepareWrapper)
  # TODO: noCallbackFallback not yet supported in orchestrion-config (nodejs/orchestrion-js pending)
  - module_name: mariadb
    version_range: ">=3"
    file_path: lib/cmd/class/prepare-result-packet.js
    function_query:
      name: execute
      type: method
      kind: callback
      class: PrepareResultPacket
    operator: traceCallback
    channel_name: "PrepareResultPacket_execute"
`
