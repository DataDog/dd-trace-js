'use strict'

module.exports = [
  // -------------------------------------------------------------------------
  // Orchestrion entries — these hooks are loaded via getHooks('mariadb')
  // -------------------------------------------------------------------------
  // Pool.getConnection(callback?) — supports both callback and promise call
  // shapes; kind: 'Auto' picks the right wrapper at runtime based on whether
  // a callback function was passed.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3.4.1',
      filePath: 'lib/pool.js',
    },
    functionQuery: {
      methodName: 'getConnection',
      className: 'Pool',
      kind: 'Auto',
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
  // v2 query hooks — use objectName: 'this' + propertyName to target
  // arrow-function instance properties set inside function constructors
  // (orchestrion-js #58).
  // -------------------------------------------------------------------------

  // v>=2.5.2 <3: _queryPromise (promise API)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.5.2 <3',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      objectName: 'this',
      propertyName: '_queryPromise',
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
      objectName: 'this',
      propertyName: 'query',
      kind: 'Async',
    },
    channelName: 'v2Connection_query',
  },
  // All v2: _queryCallback (callback API; Auto handles the no-callback case)
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/connection.js',
    },
    functionQuery: {
      objectName: 'this',
      propertyName: '_queryCallback',
      kind: 'Auto',
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
      objectName: 'this',
      propertyName: 'getConnection',
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
      objectName: 'this',
      propertyName: 'query',
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
  // ConnectionCallback.prototype.query — callback API; query() may be invoked
  // without a callback (event-emitter usage), so use kind: 'Auto'.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-callback.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'ConnectionCallback',
      kind: 'Auto',
    },
    channelName: 'ConnectionCallback_query',
  },
  // ConnectionCallback.prototype.execute — callback API; may be invoked
  // without a callback, so use kind: 'Auto'.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/connection-callback.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'ConnectionCallback',
      kind: 'Auto',
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
  // PoolCallback.prototype.query — pool.query() is often invoked without a
  // callback (fire-and-forget); kind: 'Auto' falls back to the promise path.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-callback.js',
    },
    functionQuery: {
      methodName: 'query',
      className: 'PoolCallback',
      kind: 'Auto',
    },
    channelName: 'PoolCallback_query',
  },
  // PoolCallback.prototype.execute — same fire-and-forget shape as query.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/pool-callback.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'PoolCallback',
      kind: 'Auto',
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
  // PrepareResultPacket.prototype.execute — used via PrepareWrapper
  // (statement.execute). ctx.self is PrepareWrapper: .query = SQL,
  // .conn.opts = connection options. execute() may be called without a
  // callback (promise mode); kind: 'Auto' covers both paths.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/cmd/class/prepare-result-packet.js',
    },
    functionQuery: {
      methodName: 'execute',
      className: 'PrepareResultPacket',
      kind: 'Auto',
    },
    channelName: 'PrepareResultPacket_execute',
  },

  // -------------------------------------------------------------------------
  // Command-level lifecycle hooks.
  //
  // The user-facing API hooks above own context propagation (their
  // `wrapCallback`-generated `asyncStart.runStores` is what restores the
  // parent store inside user callbacks), but they cannot reliably emit a
  // finish signal for every call shape: `kind: 'Auto'` falls back to the
  // promise-wrapper body when no callback was passed, and that body silently
  // exits when the function returns a non-thenable (e.g. v3
  // `connection.query(sql)` returning a Query EventEmitter), leaving the
  // span unfinished.
  //
  // The mariadb lib gives us deterministic protocol-level signals on the
  // base `Command` class — every query/execute (callback or promise,
  // pooled or direct, prepared or ad-hoc) ends at either
  // `Command.prototype.successEnd` or `Command.prototype.throwError`. We
  // hook the Query/Execute constructors for span CREATION and those two
  // base methods for span FINISH. The Command instance is the join key
  // (carried as `ctx.self` on every channel).
  // -------------------------------------------------------------------------

  // v>=3 Query Command constructor — `(resolve, reject, connOpts, cmdParam)`.
  // After super() runs, the instance has `this.sql` and `this.opts` (which
  // already merges connOpts).
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/cmd/query.js',
    },
    functionQuery: {
      className: 'Query',
    },
    channelName: 'Query_construct',
  },

  // v>=3 Execute Command constructor —
  // `(resolve, reject, connOpts, cmdParam, prepare)`.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=3',
      filePath: 'lib/cmd/execute.js',
    },
    functionQuery: {
      className: 'Execute',
    },
    channelName: 'Execute_construct',
  },

  // v<3 Query Command constructor —
  // `(resolve, reject, cmdOpts, connOpts, sql, values)`.
  // v2's `configAssign` strips host/user/database/port from `this.opts`, so
  // the plugin reads connOpts directly from the constructor arguments.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4 <3',
      filePath: 'lib/cmd/query.js',
    },
    functionQuery: {
      className: 'Query',
    },
    channelName: 'v2Query_construct',
  },

  // Command.prototype.successEnd — protocol-level success completion. Called
  // exactly once per Command on the success path (parser/resultset code
  // invokes it after the final response packet). Hooked on the base class
  // so v2 and v3 share the channel.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4',
      filePath: 'lib/cmd/command.js',
    },
    functionQuery: {
      methodName: 'successEnd',
      className: 'Command',
      kind: 'Sync',
    },
    channelName: 'Command_successEnd',
  },

  // Command.prototype.throwError — protocol-level error completion. `ctx.arguments[0]`
  // is the error.
  {
    module: {
      name: 'mariadb',
      versionRange: '>=2.0.4',
      filePath: 'lib/cmd/command.js',
    },
    functionQuery: {
      methodName: 'throwError',
      className: 'Command',
      kind: 'Sync',
    },
    channelName: 'Command_throwError',
  },
]
