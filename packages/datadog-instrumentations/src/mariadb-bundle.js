'use strict'

const { errorMonitor } = require('node:events')

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')

const activeCommands = new WeakMap()
const commandMethods = ['query', 'execute', 'batch']
const emptyConnectionContext = { currentStore: {} }
const emptyOptions = {}
const wrappedClients = new WeakSet()
const wrappedConnections = new WeakSet()
const IMPORT_FILE_RESOURCE = 'IMPORT FILE'
const noop = () => {}
const STATUS_IN_TRANSACTION = 1
const transactionMethods = [
  ['beginTransaction', 'START TRANSACTION'],
  ['commit', 'COMMIT'],
  ['rollback', 'ROLLBACK'],
]

/** @typedef {NonNullable<ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>>} Descriptor */

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
 * Parses connection options without allowing instrumentation to break the factory call.
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
 * Creates a promise-returning command wrapper.
 *
 * @param {object} options
 * @param {unknown} [preparedSql]
 * @param {object} [commandOwner]
 * @returns {(command: Function) => Function}
 */
function createWrapPromiseCommand (options, preparedSql, commandOwner) {
  return function wrapCommand (command) {
    return function (sql) {
      if (!startCh.hasSubscribers) return command.apply(this, arguments)

      const owner = commandOwner ?? this
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }

      startCommand(owner)

      let result
      try {
        result = startCh.runStores(ctx, command, this, ...arguments)
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

/**
 * Creates a callback command wrapper and supplies a completion callback when the caller omits one.
 *
 * @param {object} options
 * @param {unknown} [preparedSql]
 * @param {object} [commandOwner]
 * @param {number} [commandArity] Original arity when command is wrapped by a variadic forwarding function.
 * @returns {(command: Function) => Function}
 */
function createWrapCallbackCommand (options, preparedSql, commandOwner, commandArity) {
  return function wrapCommand (command) {
    const callbackIndex = (commandArity ?? command.length) - 1

    return function (sql) {
      if (!startCh.hasSubscribers) return command.apply(this, arguments)

      const owner = commandOwner ?? this
      const callback = arguments[arguments.length - 1]
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }
      const wrapper = callback => function (error) {
        finishCommandState(ctx, owner, error)

        return typeof callback === 'function'
          ? finishCh.runStores(ctx, callback, this, ...arguments)
          : finishCh.runStores(ctx, noop, this)
      }

      if (typeof callback === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapCallback(callback, wrapper)
      } else if (callbackIndex >= 0 && arguments.length > callbackIndex && arguments[callbackIndex] == null) {
        arguments[callbackIndex] = wrapper()
      } else {
        arguments.length = Math.max(arguments.length + 1, callbackIndex + 1)
        arguments[arguments.length - 1] = wrapper()
      }

      startCommand(owner)

      try {
        return startCh.runStores(ctx, command, this, ...arguments)
      } catch (error) {
        finishCommand(ctx, owner, error)
        throw error
      }
    }
  }
}

/**
 * Traces a Readable-returning command without replacing the stream.
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

/**
 * Wraps command methods exposed by a bundled client.
 *
 * @param {object} client
 * @param {(command: Function) => Function} wrapper
 * @returns {void}
 */
function wrapClientCommands (client, wrapper) {
  if (wrappedClients.has(client)) return

  wrappedClients.add(client)
  for (const method of commandMethods) {
    if (typeof client[method] === 'function') shimmer.wrap(client, method, wrapper)
  }
}

/**
 * Wraps transaction helpers whose bundled implementations bypass the public query methods.
 *
 * @param {object} client
 * @param {object} options
 * @param {(options: object, sql: string, owner?: object, commandArity?: number) =>
 *   (command: Function) => Function} createWrapper
 * @returns {void}
 */
function wrapTransactionMethods (client, options, createWrapper) {
  for (const [method, sql] of transactionMethods) {
    shimmer.wrap(client, method, createWrapTransaction(options, sql, createWrapper))
  }
}

/**
 * Traces a transaction helper only when MariaDB sends its command.
 *
 * @param {object} options
 * @param {string} sql
 * @param {(options: object, sql: string, owner?: object, commandArity?: number) =>
 *   (command: Function) => Function} createWrapper
 * @returns {(transaction: Function) => Function}
 */
function createWrapTransaction (options, sql, createWrapper) {
  return function wrapTransaction (transaction) {
    const tracedTransaction = createWrapper(options, sql, undefined, transaction.length)(function () {
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
 * Wraps a promise connection and the prepared statements it creates.
 *
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function wrapPromiseConnection (connection, options) {
  wrapClientCommands(connection, createWrapPromiseCommand(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  shimmer.wrap(connection, 'importFile', createWrapPromiseCommand(options, IMPORT_FILE_RESOURCE))
  if (typeof connection.queryStream === 'function') {
    shimmer.wrap(connection, 'queryStream', createWrapStream(options))
  }
  shimmer.wrap(connection, 'prepare', createWrapPromisePrepare(options))
  wrapTransactionMethods(connection, options, createWrapPromiseCommand)

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
  wrapClientCommands(connection, createWrapCallbackCommand(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  shimmer.wrap(connection, 'importFile', createWrapCallbackCommand(options, IMPORT_FILE_RESOURCE))
  if (typeof connection.queryStream === 'function') {
    shimmer.wrap(connection, 'queryStream', createWrapStream(options))
  }
  shimmer.wrap(connection, 'prepare', createWrapCallbackPrepare(options))
  wrapTransactionMethods(connection, options, createWrapCallbackCommand)

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
        shimmer.wrap(statement, 'execute', createWrapPromiseCommand(options, preparedSql, connection))
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
      const callback = arguments[arguments.length - 1]
      if (typeof callback !== 'function') return prepare.apply(this, arguments)

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
        return callback.apply(this, arguments)
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
    const executeWithCallback = createWrapCallbackCommand(options, sql, connection)(execute)
    const executeWithPromise = createWrapPromiseCommand(options, sql, connection)(execute)

    return function () {
      const hasCallback = typeof arguments[1] === 'function' || typeof arguments[2] === 'function'
      const wrappedExecute = hasCallback ? executeWithCallback : executeWithPromise
      return wrappedExecute.apply(this, arguments)
    }
  }
}

/**
 * Runs bundled pool internals in the skip store while tracing the public command.
 *
 * @param {object} options
 * @param {(options: object, sql?: unknown, owner?: object, commandArity?: number) =>
 *   (command: Function) => Function} createWrapper
 * @param {unknown} [preparedSql]
 * @returns {(command: Function) => Function}
 */
function createWrapPoolCommand (options, createWrapper, preparedSql) {
  return function wrapPoolCommand (command) {
    return createWrapper(options, preparedSql, undefined, command.length)(function () {
      return skipCh.runStores({}, command, this, ...arguments)
    })
  }
}

/**
 * Restores the caller context and instruments a pooled promise connection.
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
 * Restores the caller context when a promise acquisition fails.
 *
 * @param {object} ctx
 * @param {Error} error
 * @throws {Error} The connection acquisition error.
 */
function finishPromiseGetConnectionError (ctx, error) {
  return connectionFinishCh.runStores(ctx, () => { throw error })
}

/**
 * Wraps getConnection on a bundled promise pool.
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
 * Wraps getConnection on a bundled callback pool.
 *
 * @param {object} options
 * @returns {(getConnection: Function) => Function}
 */
function createWrapCallbackGetConnection (options) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const callback = arguments[arguments.length - 1]
      if (typeof callback !== 'function') return getConnection.apply(this, arguments)

      const ctx = {}
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
 * Instruments connection wrappers emitted when a bundled pool creates a connection.
 *
 * @param {object} pool
 * @param {object} options
 * @param {(connection: object, options: object) => object} wrapConnection
 * @returns {void}
 */
function wrapPoolConnectionEvent (pool, options, wrapConnection) {
  shimmer.wrap(pool, 'emit', emit => function (event, connection) {
    if (event !== 'connection') return emit.apply(this, arguments)
    wrapConnection(connection, options)
    return connectionFinishCh.runStores(emptyConnectionContext, emit, this, ...arguments)
  })
}

/**
 * Captures the connection options registered with a pool cluster.
 *
 * @param {object} cluster
 * @param {Function} defaultOptions
 * @returns {(pattern: unknown) => object}
 */
function captureClusterOptions (cluster, defaultOptions) {
  const optionsByIdentifier = new Map()
  const optionsByPattern = new Map()
  let nodeCounter = 0

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
    optionsByIdentifier.clear()
    optionsByPattern.clear()
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
 * Removes options for every cluster node matching a selector.
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
 * Wraps promise connections acquired from a bundled pool cluster.
 *
 * @param {(pattern: unknown) => object} getOptions
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
 * Wraps callback connections acquired from a bundled pool cluster.
 *
 * @param {(pattern: unknown) => object} getOptions
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
  // The filtered callback facade delegates to a private Cluster instance, bypassing the public method above.
  shimmer.wrap(cluster, 'of', of => function (pattern) {
    const filteredCluster = of.apply(this, arguments)
    shimmer.wrap(filteredCluster, 'getConnection', createWrapCallbackClusterGetConnection(() => getOptions(pattern)))
    return filteredCluster
  })

  return cluster
}

/**
 * Wraps the createConnection factory from a bundled promise entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createConnection: Function) => Function}
 */
function createWrapPromiseConnectionFactory (defaultOptions) {
  return function wrapCreateConnection (createConnection) {
    return function (options) {
      return createConnection.apply(this, arguments).then(connection => {
        return wrapPromiseConnection(connection, normalizeOptions(defaultOptions, options))
      })
    }
  }
}

/**
 * Wraps the createConnection factory from a bundled callback entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createConnection: Function) => Function}
 */
function createWrapCallbackConnectionFactory (defaultOptions) {
  return function wrapCreateConnection (createConnection) {
    return function (options) {
      const connection = createConnection.apply(this, arguments)
      return wrapCallbackConnection(connection, normalizeOptions(defaultOptions, options))
    }
  }
}

/**
 * Wraps the createPool factory from a bundled promise entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createPool: Function) => Function}
 */
function createWrapPromisePoolFactory (defaultOptions) {
  return function wrapCreatePool (createPool) {
    return function (options) {
      const pool = skipCh.runStores({}, createPool, this, ...arguments)
      const normalizedOptions = normalizeOptions(defaultOptions, options)

      wrapPoolConnectionEvent(pool, normalizedOptions, wrapPromiseConnection)
      wrapClientCommands(pool, createWrapPoolCommand(normalizedOptions, createWrapPromiseCommand))
      shimmer.wrap(
        pool,
        'importFile',
        createWrapPoolCommand(normalizedOptions, createWrapPromiseCommand, IMPORT_FILE_RESOURCE)
      )
      shimmer.wrap(pool, 'getConnection', createWrapPromiseGetConnection(normalizedOptions))

      return pool
    }
  }
}

/**
 * Wraps the createPool factory from a bundled callback entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createPool: Function) => Function}
 */
function createWrapCallbackPoolFactory (defaultOptions) {
  return function wrapCreatePool (createPool) {
    return function (options) {
      const pool = skipCh.runStores({}, createPool, this, ...arguments)
      const normalizedOptions = normalizeOptions(defaultOptions, options)

      wrapPoolConnectionEvent(pool, normalizedOptions, wrapCallbackConnection)
      wrapClientCommands(pool, createWrapPoolCommand(normalizedOptions, createWrapCallbackCommand))
      shimmer.wrap(
        pool,
        'importFile',
        createWrapPoolCommand(normalizedOptions, createWrapCallbackCommand, IMPORT_FILE_RESOURCE)
      )
      shimmer.wrap(pool, 'getConnection', createWrapCallbackGetConnection(normalizedOptions))

      return pool
    }
  }
}

/**
 * Wraps the createPoolCluster factory from a bundled promise entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createPoolCluster: Function) => Function}
 */
function createWrapPromiseClusterFactory (defaultOptions) {
  return function wrapCreatePoolCluster (createPoolCluster) {
    return function () {
      return wrapPromiseCluster(createPoolCluster.apply(this, arguments), defaultOptions)
    }
  }
}

/**
 * Wraps the createPoolCluster factory from a bundled callback entry.
 *
 * @param {Function} defaultOptions
 * @returns {(createPoolCluster: Function) => Function}
 */
function createWrapCallbackClusterFactory (defaultOptions) {
  return function wrapCreatePoolCluster (createPoolCluster) {
    return function () {
      return wrapCallbackCluster(createPoolCluster.apply(this, arguments), defaultOptions)
    }
  }
}

/**
 * Wraps the top-level importFile helper from a bundled promise entry.
 *
 * @param {Function} defaultOptions
 * @returns {(importFile: Function) => Function}
 */
function createWrapPromiseImportFile (defaultOptions) {
  return function wrapImportFile (importFile) {
    return function (options) {
      const wrapper = createWrapPromiseCommand(
        normalizeOptions(defaultOptions, options),
        IMPORT_FILE_RESOURCE
      )(importFile)
      return wrapper.apply(this, arguments)
    }
  }
}

/**
 * Wraps the top-level importFile helper from a bundled callback entry.
 *
 * @param {Function} defaultOptions
 * @returns {(importFile: Function) => Function}
 */
function createWrapCallbackImportFile (defaultOptions) {
  return function wrapImportFile (importFile) {
    return function (options) {
      const wrapper = createWrapCallbackCommand(
        normalizeOptions(defaultOptions, options),
        IMPORT_FILE_RESOURCE
      )(importFile)
      return wrapper.apply(this, arguments)
    }
  }
}

/**
 * Replaces a cloned export descriptor value while preserving its descriptor shape.
 *
 * @param {Descriptor} descriptor
 * @param {unknown} value
 * @returns {void}
 */
function replaceDescriptorValue (descriptor, value) {
  if (descriptor.get) {
    descriptor.get = () => value
  } else {
    descriptor.value = value
  }
}

/**
 * Clones a CommonJS bundle namespace and wraps selected factories without mutating non-configurable exports.
 *
 * @param {object} mariadb
 * @param {Array<[string, (factory: Function) => Function]>} factories
 * @returns {object}
 */
function wrapBundle (mariadb, factories) {
  const descriptors = Object.getOwnPropertyDescriptors(mariadb)
  const defaultDescriptors = Object.getOwnPropertyDescriptors(mariadb.default)

  for (const [name, wrapper] of factories) {
    const wrapped = shimmer.wrapFunction(mariadb[name], wrapper)
    replaceDescriptorValue(descriptors[name], wrapped)
    replaceDescriptorValue(defaultDescriptors[name], wrapped)
  }

  const defaultExport = Object.defineProperties(
    Object.create(Object.getPrototypeOf(mariadb.default)),
    defaultDescriptors
  )
  replaceDescriptorValue(descriptors.default, defaultExport)

  return Object.defineProperties(Object.create(Object.getPrototypeOf(mariadb)), descriptors)
}

/**
 * Instruments the promise API exported by MariaDB's 3.5.3+ CommonJS bundle.
 *
 * @param {object} mariadb
 * @param {string} _version
 * @param {boolean} isIitm
 * @returns {object}
 */
function wrapPromiseBundle (mariadb, _version, isIitm) {
  if (isIitm) return mariadb

  const defaultOptions = mariadb.defaultOptions
  return wrapBundle(mariadb, [
    ['createConnection', createWrapPromiseConnectionFactory(defaultOptions)],
    ['createPool', createWrapPromisePoolFactory(defaultOptions)],
    ['createPoolCluster', createWrapPromiseClusterFactory(defaultOptions)],
    ['importFile', createWrapPromiseImportFile(defaultOptions)],
  ])
}

/**
 * Instruments the callback API exported by MariaDB's 3.5.3+ CommonJS bundle.
 *
 * @param {object} mariadb
 * @returns {object}
 */
function wrapCallbackBundle (mariadb) {
  const defaultOptions = mariadb.defaultOptions
  return wrapBundle(mariadb, [
    ['createConnection', createWrapCallbackConnectionFactory(defaultOptions)],
    ['createPool', createWrapCallbackPoolFactory(defaultOptions)],
    ['createPoolCluster', createWrapCallbackClusterFactory(defaultOptions)],
    ['importFile', createWrapCallbackImportFile(defaultOptions)],
  ])
}

module.exports = { wrapCallbackBundle, wrapPromiseBundle }
