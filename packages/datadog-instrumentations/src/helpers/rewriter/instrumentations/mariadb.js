'use strict'

module.exports = [
  // -------------------------------------------------------------------------
  // Orchestrion entries — these hooks are loaded via getHooks('mariadb')
  // -------------------------------------------------------------------------
  // Pool.getConnection(callback) — callback-based; NOT returning a promise.
  // Using kind: 'Callback' so the connection is available via ctx.result in
  // asyncStart.runStores, enabling correct conf propagation and context restore.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3.4.1',
      filePath: 'lib/pool.js',
    },
    functionQuery: {
      methodName: 'getConnection',
      className: 'Pool',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'Pool_getConnection',
  },
  // -------------------------------------------------------------------------
  // v2 constructor hooks — stash connection opts on the instance as __ddConf
  // -------------------------------------------------------------------------
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      functionName: 'Connection',
      kind: 'Sync',
    },
    channelName: 'v2Connection',
  },
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/pool-base.js',
    },
    functionQuery: {
      functionName: 'PoolBase',
      kind: 'Sync',
    },
    channelName: 'v2PoolBase',
  },

  // -------------------------------------------------------------------------
  // v2 query hooks — use thisPropertyName to target arrow-function instance
  // properties set inside function constructors.
  // -------------------------------------------------------------------------

  // v>=2.5.2 <3: _queryPromise (promise API)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.5.2 <3',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      thisPropertyName: '_queryPromise',
      kind: 'Async',
    },
    channelName: 'v2Connection_queryPromise',
  },
  // v>=2.0.4 <=2.5.1: query (promise API)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <=2.5.1',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      thisPropertyName: 'query',
      kind: 'Async',
    },
    channelName: 'v2Connection_query',
  },
  // All v2: _queryCallback (callback API)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      thisPropertyName: '_queryCallback',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'v2Connection_queryCallback',
  },
  // v2 pool: getConnection (promise API — context clearing + conf propagation)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/pool-base.js',
    },
    functionQuery: {
      thisPropertyName: 'getConnection',
      kind: 'Async',
    },
    channelName: 'v2PoolBase_getConnection',
  },
  // v2 pool: query (promise API)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/pool-base.js',
    },
    functionQuery: {
      thisPropertyName: 'query',
      kind: 'Async',
    },
    channelName: 'v2PoolBase_query',
  },

  // -------------------------------------------------------------------------
  // v2 callback.js — createPool/createConnection hooks
  // In v2, callback.js calls pool.initialize() right after construction,
  // which creates the first TCP connection. Hooking createPool clears context
  // so that initial connection doesn't become a child of the user's span.
  // -------------------------------------------------------------------------
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'callback.js',
    },
    functionQuery: {
      expressionName: 'createPool',
      kind: 'Sync',
    },
    channelName: 'createPool',
  },
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'callback.js',
    },
    functionQuery: {
      expressionName: 'createConnection',
      kind: 'Sync',
    },
    channelName: 'createConnection',
  },

  // -------------------------------------------------------------------------
  // Shimmer entries — v>=3 query/execute hooks that cannot use orchestrion
  // because the AST rewriter moves the constructor body into a nested
  // function, which breaks super() calls (SyntaxError).
  // -------------------------------------------------------------------------

  // callback.js — createConnection (sync wrapper to capture opts)
  // Uses expressionName because these are named function expressions
  // assigned to module.exports, not function declarations.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'callback.js',
    },
    functionQuery: {
      expressionName: 'createConnection',
      kind: 'Sync',
    },
    channelName: 'createConnection',
  },
  // callback.js — createPool (sync wrapper to capture opts)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'callback.js',
    },
    functionQuery: {
      expressionName: 'createPool',
      kind: 'Sync',
    },
    channelName: 'createPool',
  },
  // promise.js — createConnection (async — returns promise)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'promise.js',
    },
    functionQuery: {
      expressionName: 'createConnection',
      kind: 'Async',
    },
    channelName: 'createConnection',
  },
  // promise.js — createPool (sync wrapper to capture opts)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'promise.js',
    },
    functionQuery: {
      expressionName: 'createPool',
      kind: 'Sync',
    },
    channelName: 'createPool',
  },
  // ConnectionCallback.prototype.query (callback-based — callback is last arg)
  // noCallbackFallback: query() may be called without a callback (event-emitter usage)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-callback.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'ConnectionCallback',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'ConnectionCallback_query',
  },
  // ConnectionCallback.prototype.execute (callback-based — callback is last arg)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-callback.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'ConnectionCallback',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'ConnectionCallback_execute',
  },
  // ConnectionPromise.prototype.query (promise-based)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-promise.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'ConnectionPromise',
      kind: 'Async',
    },
    channelName: 'ConnectionPromise_query',
  },
  // ConnectionPromise.prototype.execute (promise-based)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-promise.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'ConnectionPromise',
      kind: 'Async',
    },
    channelName: 'ConnectionPromise_execute',
  },
  // PoolCallback.prototype.query (callback-based — callback is last arg)
  // noCallbackFallback: pool.query() is often called without a callback (fire-and-forget)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-callback.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'PoolCallback',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'PoolCallback_query',
  },
  // PoolCallback.prototype.execute (callback-based — callback is last arg)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-callback.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'PoolCallback',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'PoolCallback_execute',
  },
  // PoolPromise.prototype.query (promise-based)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-promise.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'PoolPromise',
      kind: 'Async',
    },
    channelName: 'PoolPromise_query',
  },
  // PoolPromise.prototype.execute (promise-based)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-promise.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'PoolPromise',
      kind: 'Async',
    },
    channelName: 'PoolPromise_execute',
  },
  // PrepareResultPacket.prototype.execute — used via PrepareWrapper (statement.execute)
  // ctx.self is PrepareWrapper: .query = SQL, .conn.opts = connection options
  // noCallbackFallback: execute() may be called without callback (promise mode)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/cmd/class/prepare-result-packet.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'PrepareResultPacket',
      kind: 'Callback',
      noCallbackFallback: true,
    },
    channelName: 'PrepareResultPacket_execute',
  },
]
