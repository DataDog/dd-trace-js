'use strict'

const { errorMonitor } = require('node:events')

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const commandAddCh = channel('apm:mariadb:command:add')
const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')

const activeCommands = new WeakMap()
// Pool connection events inherit the internal skip store. An explicit empty store restores tracing for user listeners
// without retaining the context in which a long-lived pool was created.
const emptyConnectionContext = { currentStore: {} }
const emptyOptions = {}
const wrappedClients = new WeakSet()
const wrappedConnections = new WeakSet()
const noop = () => {}
const STATUS_IN_TRANSACTION = 1
const transactionMethods = [
  ['beginTransaction', 'START TRANSACTION'],
  ['commit', 'COMMIT'],
  ['rollback', 'ROLLBACK'],
]

function wrapCommandStart (start, ctx) {
  return shimmer.wrapFunction(start, start => function (...args) {
    if (!startCh.hasSubscribers) return start.apply(this, args)

    const { reject, resolve } = this
    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function (...args) {
        return finishCh.runStores(ctx, resolve, this, ...args)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        ctx.error = error

        errorCh.publish(ctx)

        return finishCh.runStores(ctx, reject, this, ...arguments)
      }
    })

    return startCh.runStores(ctx, start, this, ...args)
  })
}

function wrapCommand (Command) {
  return class extends Command {
    constructor (...args) {
      super(...args)

      if (!this.start) return

      const ctx = { sql: this.sql, conf: this.opts }

      commandAddCh.publish(ctx)

      this.start = wrapCommandStart(this.start, ctx)
    }
  }
}

function createWrapQuery (options, preparedSql, commandOwner) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const owner = commandOwner ?? this
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }

      startCommand(owner)

      let result
      try {
        result = startCh.runStores(ctx, query, this, ...arguments)
      } catch (error) {
        finishCommand(ctx, owner, error)
        throw error
      }

      return result.then(result => {
        finishCommand(ctx, owner, undefined, result)
        return result
      }, error => {
        finishCommand(ctx, owner, error)
        throw error
      })
    }
  }
}

function createWrapQueryCallback (options, preparedSql, commandOwner) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const owner = commandOwner ?? this
      const cb = arguments[arguments.length - 1]
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }
      const wrapper = (cb) => function (err) {
        finishCommandState(ctx, owner, err)

        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.runStores(ctx, noop, this)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapCallback(cb, wrapper)
      } else {
        arguments.length = Math.max(arguments.length + 1, query.length)
        arguments[arguments.length - 1] = wrapper()
      }

      startCommand(owner)

      try {
        return startCh.runStores(ctx, query, this, ...arguments)
      } catch (error) {
        finishCommand(ctx, owner, error)
        throw error
      }
    }
  }
}

/**
 * Extracts SQL from MariaDB's string and object command forms.
 *
 * @param {unknown} command
 * @returns {unknown}
 */
function normalizeSql (command) {
  return command !== null && typeof command === 'object' ? command.sql : command
}

/**
 * Matches MariaDB's use of the default cluster selector for every falsy pattern.
 *
 * @param {unknown} pattern
 * @returns {unknown}
 */
function normalizeClusterPattern (pattern) {
  return pattern || /^/
}

/**
 * Marks a command as active on its owning public connection.
 *
 * @param {object} owner
 * @returns {void}
 */
function startCommand (owner) {
  activeCommands.set(owner, (activeCommands.get(owner) ?? 0) + 1)
}

/**
 * Releases one active command without clearing concurrent commands.
 *
 * @param {object} owner
 * @returns {void}
 */
function endCommand (owner) {
  const active = activeCommands.get(owner)
  if (active === 1) {
    activeCommands.delete(owner)
  } else if (active !== undefined) {
    activeCommands.set(owner, active - 1)
  }
}

/**
 * Publishes command completion state and releases its owner.
 *
 * @param {object} ctx
 * @param {object} owner
 * @param {Error} [error]
 * @param {unknown} [result]
 * @returns {void}
 */
function finishCommandState (ctx, owner, error, result) {
  endCommand(owner)
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  ctx.result = result
}

/**
 * Publishes a complete command lifecycle outside a callback continuation.
 *
 * @param {object} ctx
 * @param {object} owner
 * @param {Error} [error]
 * @param {unknown} [result]
 * @returns {void}
 */
function finishCommand (ctx, owner, error, result) {
  finishCommandState(ctx, owner, error, result)
  finishCh.publish(ctx)
}

/**
 * Traces a Readable-returning MariaDB command without replacing the stream.
 *
 * @param {object} options
 * @param {unknown} [preparedSql]
 * @param {object} [commandOwner]
 * @returns {(streamMethod: Function) => Function}
 */
function createWrapStream (options, preparedSql, commandOwner) {
  return function wrapStream (streamMethod) {
    return function (sql) {
      if (!startCh.hasSubscribers) return streamMethod.apply(this, arguments)

      const owner = commandOwner ?? this
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }
      let stream

      startCommand(owner)
      try {
        stream = startCh.runStores(ctx, streamMethod, this, ...arguments)
      } catch (error) {
        finishCommand(ctx, owner, error)
        throw error
      }

      let finished = false
      const cleanup = () => {
        stream.removeListener('end', onEnd)
        stream.removeListener('close', onClose)
        stream.removeListener(errorMonitor, onError)
      }
      const complete = error => {
        if (finished) return
        finished = true
        cleanup()
        finishCommand(ctx, owner, error)
      }
      const onEnd = () => complete()
      const onClose = () => complete()
      const onError = error => complete(error)

      stream.once('end', onEnd)
      stream.once('close', onClose)
      stream.once(errorMonitor, onError)

      return stream
    }
  }
}

function wrapConnection (promiseMethod, Connection) {
  return function (options) {
    Connection.apply(this, arguments)

    shimmer.wrap(this, promiseMethod, createWrapQuery(options))
    shimmer.wrap(this, '_queryCallback', createWrapQueryCallback(options))
  }
}

function wrapPoolBase (PoolBase) {
  return function (options, processTask, createConnectionPool, pingPromise) {
    arguments[1] = wrapPoolMethod(processTask)
    arguments[2] = wrapPoolMethod(createConnectionPool)

    PoolBase.apply(this, arguments)

    shimmer.wrap(this, 'query', createWrapQuery(options.connOptions))
  }
}

// It's not possible to prevent connection pools from leaking across queries,
// so instead we just skip instrumentation completely to avoid memory leaks
// and/or orphan spans.
function wrapPoolMethod (createConnection) {
  return function (...args) {
    return skipCh.runStores({}, createConnection, this, ...args)
  }
}

function wrapPoolGetConnectionMethod (getConnection) {
  return function wrappedGetConnection (...args) {
    const cb = args.at(-1)
    if (typeof cb !== 'function') return getConnection.apply(this, args)

    const ctx = {}

    args[args.length - 1] = function (...args) {
      return connectionFinishCh.runStores(ctx, cb, this, ...args)
    }

    connectionStartCh.publish(ctx)

    return getConnection.apply(this, args)
  }
}

/**
 * Wraps the public query methods exposed by MariaDB's bundled CommonJS clients.
 *
 * @param {object} client
 * @param {(query: Function) => Function} wrapper
 * @returns {void}
 */
function wrapClient (client, wrapper) {
  if (wrappedClients.has(client)) return

  wrappedClients.add(client)
  shimmer.wrap(client, 'query', wrapper)
  shimmer.wrap(client, 'execute', wrapper)
}

/**
 * Wraps a promise connection and the prepared statements it creates.
 *
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function wrapPromiseConnection (connection, options) {
  wrapClient(connection, createWrapQuery(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  if (typeof connection.queryStream === 'function') {
    shimmer.wrap(connection, 'queryStream', createWrapStream(options))
  }
  shimmer.wrap(connection, 'prepare', createWrapPromisePrepare(options))
  wrapTransactionMethods(connection, options, createWrapQuery)

  return connection
}

/**
 * Wraps a callback connection and the prepared statements it creates.
 *
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function wrapCallbackConnection (connection, options) {
  wrapClient(connection, createWrapQueryCallback(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  if (typeof connection.queryStream === 'function') {
    shimmer.wrap(connection, 'queryStream', createWrapStream(options))
  }
  shimmer.wrap(connection, 'prepare', createWrapCallbackPrepare(options))
  wrapTransactionMethods(connection, options, createWrapQueryCallback)

  return connection
}

/**
 * Wraps prepared statements created by a promise connection.
 *
 * @param {object} options
 * @returns {(prepare: Function) => Function}
 */
function createWrapPromisePrepare (options) {
  return function wrapPrepare (prepare) {
    return function (sql) {
      const connection = this
      const preparedSql = normalizeSql(sql)
      return prepare.apply(this, arguments).then(statement => {
        shimmer.wrap(statement, 'execute', createWrapQuery(options, preparedSql, connection))
        if (typeof statement.executeStream === 'function') {
          shimmer.wrap(statement, 'executeStream', createWrapStream(options, preparedSql, connection))
        }
        return statement
      })
    }
  }
}

/**
 * Wraps prepared statements created by a callback connection.
 *
 * @param {object} options
 * @returns {(prepare: Function) => Function}
 */
function createWrapCallbackPrepare (options) {
  return function wrapPrepare (prepare) {
    return function (sql) {
      const connection = this
      const preparedSql = normalizeSql(sql)
      const cb = arguments[arguments.length - 1]
      if (typeof cb !== 'function') return prepare.apply(this, arguments)

      arguments[arguments.length - 1] = function () {
        const statement = arguments[1]
        if (statement) {
          shimmer.wrap(
            statement,
            'execute',
            createWrapCallbackPreparedExecute(options, preparedSql, connection)
          )
          if (typeof statement.executeStream === 'function') {
            shimmer.wrap(statement, 'executeStream', createWrapStream(options, preparedSql, connection))
          }
        }
        return cb.apply(this, arguments)
      }

      return prepare.apply(this, arguments)
    }
  }
}

/**
 * Wraps callback prepared statements, which return a promise when no callback is provided.
 *
 * @param {object} options
 * @param {unknown} sql
 * @param {object} connection
 * @returns {(execute: Function) => Function}
 */
function createWrapCallbackPreparedExecute (options, sql, connection) {
  return function wrapExecute (execute) {
    const executeWithCallback = createWrapQueryCallback(options, sql, connection)(execute)
    const executeWithPromise = createWrapQuery(options, sql, connection)(execute)

    return function () {
      const hasCallback = typeof arguments[1] === 'function' || typeof arguments[2] === 'function'
      const wrappedExecute = hasCallback ? executeWithCallback : executeWithPromise
      return wrappedExecute.apply(this, arguments)
    }
  }
}

/**
 * Wraps transaction helpers whose bundled implementations bypass the public query methods.
 *
 * @param {object} client
 * @param {object} options
 * @param {(options: object, sql: string) => (query: Function) => Function} createWrapper
 * @returns {void}
 */
function wrapTransactionMethods (client, options, createWrapper) {
  for (const [method, sql] of transactionMethods) {
    shimmer.wrap(client, method, createWrapTransaction(options, sql, createWrapper))
  }
}

/**
 * Traces a transaction helper while suppressing any nested public query it invokes.
 *
 * @param {object} options
 * @param {string} sql
 * @param {(options: object, sql: string) => (query: Function) => Function} createWrapper
 * @returns {(transaction: Function) => Function}
 */
function createWrapTransaction (options, sql, createWrapper) {
  return function wrapTransaction (transaction) {
    const tracedTransaction = createWrapper(options, sql)(function () {
      return skipCh.runStores({}, transaction, this, ...arguments)
    })

    return function () {
      if (!startCh.hasSubscribers) return transaction.apply(this, arguments)

      if (sql !== 'START TRANSACTION' &&
        !activeCommands.has(this) &&
        !(this.info?.status & STATUS_IN_TRANSACTION)) {
        return transaction.apply(this, arguments)
      }

      return tracedTransaction.apply(this, arguments)
    }
  }
}

/**
 * Runs pool internals in the instrumentation skip store while tracing the public query.
 *
 * @param {object} options
 * @param {(options: object) => (query: Function) => Function} createWrapper
 * @returns {(query: Function) => Function}
 */
function createWrapPoolQuery (options, createWrapper) {
  return function wrapPoolQuery (query) {
    return createWrapper(options)(function () {
      return skipCh.runStores({}, query, this, ...arguments)
    })
  }
}

/**
 * Restores the caller's context and instruments a pooled promise connection.
 *
 * @param {object} ctx
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function finishPromiseGetConnection (ctx, connection, options) {
  return connectionFinishCh.runStores(ctx, wrapPromiseConnection, undefined, connection, options)
}

/**
 * Restores the caller's context when acquiring a promise connection fails.
 *
 * @param {object} ctx
 * @param {Error} error
 * @throws {Error} The connection acquisition error.
 */
function finishPromiseGetConnectionError (ctx, error) {
  return connectionFinishCh.runStores(ctx, () => { throw error })
}

/**
 * Wraps getConnection on MariaDB's bundled CommonJS promise pool.
 *
 * @param {object} options
 * @returns {(getConnection: Function) => Function}
 */
function createWrapPromiseGetConnection (options) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const ctx = {}

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments).then(
        connection => finishPromiseGetConnection(ctx, connection, options),
        error => finishPromiseGetConnectionError(ctx, error)
      )
    }
  }
}

/**
 * Wraps getConnection on MariaDB's bundled CommonJS callback pool.
 *
 * @param {object} options
 * @returns {(getConnection: Function) => Function}
 */
function createWrapCallbackGetConnection (options) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const cb = arguments[arguments.length - 1]
      if (typeof cb !== 'function') return getConnection.apply(this, arguments)

      const ctx = {}
      arguments[arguments.length - 1] = function () {
        const connection = arguments[1]
        if (connection) wrapCallbackConnection(connection, options)
        return connectionFinishCh.runStores(ctx, cb, this, ...arguments)
      }

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments)
    }
  }
}

/**
 * Instruments public connection wrappers emitted when a bundled pool creates a connection.
 *
 * @param {object} pool
 * @param {object} options
 * @param {(connection: object, options: object) => object} wrapConnection
 * @returns {void}
 */
function wrapPoolConnectionEvent (pool, options, wrapConnection) {
  const onConnection = connection => wrapConnection(connection, options)

  pool.prependListener('connection', onConnection)
  shimmer.wrap(pool, 'emit', emit => function (event) {
    if (event !== 'connection') return emit.apply(this, arguments)
    return connectionFinishCh.runStores(emptyConnectionContext, emit, this, ...arguments)
  })
  shimmer.wrap(pool, 'end', end => function () {
    pool.removeListener('connection', onConnection)
    return end.apply(this, arguments)
  })
}

/**
 * Captures the connection options registered with a pool cluster.
 *
 * @param {object} cluster
 * @param {Function} defaultOptions
 * @returns {(pattern: string|undefined) => object}
 */
function captureClusterOptions (cluster, defaultOptions) {
  const optionsByIdentifier = new Map()
  const optionsByPattern = new Map()
  let nodeCounter = 0

  const clearOptions = () => {
    optionsByIdentifier.clear()
    optionsByPattern.clear()
  }

  const removeOptions = identifier => {
    optionsByIdentifier.delete(identifier)
    optionsByPattern.clear()
  }

  const eventEmitter = cluster.on('remove', removeOptions)

  shimmer.wrap(cluster, 'add', add => function (identifier, options) {
    const hasIdentifier = typeof identifier === 'string' ||
      Object.prototype.toString.call(identifier) === '[object String]'
    const generatedIdentifier = hasIdentifier ? String(identifier) : `PoolNode-${nodeCounter++}`
    const connectionOptions = hasIdentifier ? options : identifier
    const result = skipCh.runStores({}, add, this, ...arguments)
    optionsByIdentifier.set(generatedIdentifier, normalizeOptions(defaultOptions, connectionOptions))
    optionsByPattern.clear()
    return result
  })

  shimmer.wrap(cluster, 'remove', remove => function (pattern) {
    const result = remove.apply(this, arguments)
    removeClusterOptions(optionsByIdentifier, pattern)
    optionsByPattern.clear()
    return result
  })

  shimmer.wrap(cluster, 'end', end => function () {
    clearOptions()
    eventEmitter.removeListener('remove', removeOptions)
    return end.apply(this, arguments)
  })

  return pattern => {
    const normalizedPattern = normalizeClusterPattern(pattern)
    const cacheKey = String(normalizedPattern)
    const cachedOptions = optionsByPattern.get(cacheKey)
    if (cachedOptions !== undefined) return cachedOptions

    const regularExpression = new RegExp(normalizedPattern)
    let matchedOptions

    for (const [identifier, options] of optionsByIdentifier) {
      regularExpression.lastIndex = 0
      if (!regularExpression.test(identifier)) continue
      if (matchedOptions !== undefined) {
        optionsByPattern.set(cacheKey, emptyOptions)
        return emptyOptions
      }
      matchedOptions = options
    }

    matchedOptions ??= emptyOptions
    optionsByPattern.set(cacheKey, matchedOptions)
    return matchedOptions
  }
}

/**
 * Removes the options for every cluster node matching a selector.
 *
 * @param {Map<string, object>} optionsByIdentifier
 * @param {string} pattern
 * @returns {void}
 */
function removeClusterOptions (optionsByIdentifier, pattern) {
  const regularExpression = new RegExp(pattern)

  for (const identifier of optionsByIdentifier.keys()) {
    regularExpression.lastIndex = 0
    if (regularExpression.test(identifier)) optionsByIdentifier.delete(identifier)
  }
}

/**
 * Normalizes connection options with MariaDB's public parser without allowing instrumentation to break the factory.
 *
 * @param {Function} defaultOptions
 * @param {unknown} options
 * @returns {object}
 */
function normalizeOptions (defaultOptions, options) {
  try {
    return defaultOptions(options)
  } catch {
    return options !== null && typeof options === 'object' ? options : {}
  }
}

/**
 * Wraps promise connections acquired from a bundled pool cluster using the selected node's options.
 *
 * @param {(pattern: string|undefined) => object} getOptions
 * @returns {(getConnection: Function) => Function}
 */
function createWrapPromiseClusterGetConnection (getOptions) {
  return function wrapGetConnection (getConnection) {
    return function (pattern) {
      const ctx = {}
      const options = getOptions(pattern)

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments).then(
        connection => finishPromiseGetConnection(ctx, connection, options),
        error => finishPromiseGetConnectionError(ctx, error)
      )
    }
  }
}

/**
 * Wraps callback connections acquired from a bundled pool cluster using the selected node's options.
 *
 * @param {(pattern: string|undefined) => object} getOptions
 * @returns {(getConnection: Function) => Function}
 */
function createWrapCallbackClusterGetConnection (getOptions) {
  return function wrapGetConnection (getConnection) {
    return function (pattern) {
      const callback = arguments[arguments.length - 1]
      if (typeof callback !== 'function') return getConnection.apply(this, arguments)

      const ctx = {}
      const options = getOptions(typeof pattern === 'function' ? undefined : pattern)
      arguments[arguments.length - 1] = function () {
        const connection = arguments[1]
        if (connection) wrapCallbackConnection(connection, options)
        return connectionFinishCh.runStores(ctx, callback, this, ...arguments)
      }

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments)
    }
  }
}

/**
 * Wraps promise connections acquired from a bundled pool cluster.
 *
 * @param {object} cluster
 * @param {Function} defaultOptions
 * @returns {object}
 */
function wrapPromiseCluster (cluster, defaultOptions) {
  const getOptions = captureClusterOptions(cluster, defaultOptions)

  shimmer.wrap(cluster, 'getConnection', createWrapPromiseClusterGetConnection(getOptions))

  return cluster
}

/**
 * Wraps callback connections acquired from a bundled pool cluster.
 *
 * @param {object} cluster
 * @param {Function} defaultOptions
 * @returns {object}
 */
function wrapCallbackCluster (cluster, defaultOptions) {
  const getOptions = captureClusterOptions(cluster, defaultOptions)

  shimmer.wrap(cluster, 'getConnection', createWrapCallbackClusterGetConnection(getOptions))

  shimmer.wrap(cluster, 'of', of => function (pattern) {
    const filteredCluster = of.apply(this, arguments)
    shimmer.wrap(filteredCluster, 'getConnection', createWrapCallbackClusterGetConnection(() => getOptions(pattern)))
    return filteredCluster
  })

  return cluster
}

/**
 * Instruments the promise API exported by MariaDB's bundled CommonJS entry.
 *
 * @param {object} mariadb
 * @param {string} _version
 * @param {boolean} isIitm
 * @returns {object}
 */
function wrapPromiseBundle (mariadb, _version, isIitm) {
  if (isIitm) return mariadb

  mariadb = { ...mariadb, default: { ...mariadb.default } }

  shimmer.wrap(mariadb, 'createConnection', createConnection => function (options) {
    return createConnection.apply(this, arguments).then(connection => {
      return wrapPromiseConnection(connection, normalizeOptions(mariadb.defaultOptions, options))
    })
  })

  shimmer.wrap(mariadb, 'createPool', createPool => function (options) {
    const pool = skipCh.runStores({}, createPool, this, ...arguments)
    const normalizedOptions = normalizeOptions(mariadb.defaultOptions, options)
    wrapPoolConnectionEvent(pool, normalizedOptions, wrapPromiseConnection)
    wrapClient(pool, createWrapPoolQuery(normalizedOptions, createWrapQuery))
    shimmer.wrap(pool, 'getConnection', createWrapPromiseGetConnection(normalizedOptions))
    return pool
  })

  shimmer.wrap(mariadb, 'createPoolCluster', createPoolCluster => function () {
    return wrapPromiseCluster(createPoolCluster.apply(this, arguments), mariadb.defaultOptions)
  })

  mariadb.default.createConnection = mariadb.createConnection
  mariadb.default.createPool = mariadb.createPool
  mariadb.default.createPoolCluster = mariadb.createPoolCluster

  return mariadb
}

/**
 * Instruments the callback API exported by MariaDB's bundled CommonJS entry.
 *
 * @param {object} mariadb
 * @returns {object}
 */
function wrapCallbackBundle (mariadb) {
  mariadb = { ...mariadb, default: { ...mariadb.default } }

  shimmer.wrap(mariadb, 'createConnection', createConnection => function (options) {
    const connection = createConnection.apply(this, arguments)
    return wrapCallbackConnection(connection, normalizeOptions(mariadb.defaultOptions, options))
  })

  shimmer.wrap(mariadb, 'createPool', createPool => function (options) {
    const pool = skipCh.runStores({}, createPool, this, ...arguments)
    const normalizedOptions = normalizeOptions(mariadb.defaultOptions, options)
    wrapPoolConnectionEvent(pool, normalizedOptions, wrapCallbackConnection)
    wrapClient(pool, createWrapPoolQuery(normalizedOptions, createWrapQueryCallback))
    shimmer.wrap(pool, 'getConnection', createWrapCallbackGetConnection(normalizedOptions))
    return pool
  })

  shimmer.wrap(mariadb, 'createPoolCluster', createPoolCluster => function () {
    return wrapCallbackCluster(createPoolCluster.apply(this, arguments), mariadb.defaultOptions)
  })

  mariadb.default.createConnection = mariadb.createConnection
  mariadb.default.createPool = mariadb.createPool
  mariadb.default.createPoolCluster = mariadb.createPoolCluster

  return mariadb
}

/**
 * Instruments the MariaDB pool implementation used by 3.4.1 and newer.
 *
 * @param {Function} Pool
 * @returns {Function}
 */
function wrapPool (Pool) {
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)
  shimmer.wrap(Pool.prototype, '_createPoolConnection', wrapPoolMethod)

  return Pool
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3 <3.5.1'] }, wrapCommand)
addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3.5.1'], patchDefault: true }, wrapCommand)

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3 <3.5.1'] }, wrapCommand)
addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3.5.1'], patchDefault: true }, wrapCommand)

// mariadb 3.4.1 refactored the pool: getConnection switched from promises to
// callbacks and _createConnection was renamed to _createPoolConnection.
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1 <3.5.1'] }, wrapPool)
addHook({ name, file: 'lib/pool.js', versions: ['>=3.5.1'], patchDefault: true }, wrapPool)

addHook({ name, file: 'lib/pool.js', versions: ['>=3 <3.4.1'] }, (Pool) => {
  shimmer.wrap(Pool.prototype, '_createConnection', wrapPoolMethod)

  return Pool
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.5.2 <3'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, '_queryPromise'))
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.0.4 <=2.5.1'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, 'query'))
})

addHook({ name, file: 'lib/pool-base.js', versions: ['>=2.0.4 <3'] }, (PoolBase) => {
  return shimmer.wrapFunction(PoolBase, wrapPoolBase)
})

// MariaDB 3.5.3 added minified single-file CommonJS bundles whose internal classes cannot be targeted by Orchestrion
// or module-loader hooks, so instrument the runtime objects returned by their public factories instead.
addHook({ name, versions: ['>=3.5.3'] }, wrapPromiseBundle)
addHook({ name, file: 'dist/callback.cjs', versions: ['>=3.5.3'] }, wrapCallbackBundle)
