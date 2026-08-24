'use strict'

const { errorMonitor } = require('node:events')
const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')
const { acquireWait, reportPoolAcquireError } = require('./helpers/pool-acquire')

const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')
const acquireStartCh = channel('apm:mariadb:pool:acquire:start')
const acquireFinishCh = channel('apm:mariadb:pool:acquire:finish')
const poolAcquireChannels = {
  connectionFinishCh,
  acquireStartCh,
  acquireFinishCh,
}

const activeCommands = new WeakMap()
const commandMethods = ['query', 'execute', 'batch']
const trackedCommandMethods = ['changeUser', 'ping', 'prepare', 'reset']
const emptyConnectionContext = { currentStore: {} }
const emptyOptions = {}
const wrappedClients = new WeakSet()
const wrappedConnections = new WeakSet()
const IMPORT_FILE_RESOURCE = 'IMPORT FILE'
const noop = () => {}
const POOL_ACQUISITION_COMPACTION_THRESHOLD = 1024
const STATUS_IN_TRANSACTION = 1
const transactionMethods = [
  ['beginTransaction', 'START TRANSACTION'],
  ['commit', 'COMMIT'],
  ['rollback', 'ROLLBACK'],
]

/** @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike */
/** @typedef {{ options: object, pendingRemovals: number }} ClusterNodeOptions */
/** @typedef {{ options?: object }} ClusterSelection */
/** @typedef {import('node:async_hooks').AsyncLocalStorage<ClusterSelection>} ClusterSelectionStorage */
/**
 * @typedef {object} PoolAcquisition
 * @property {Record<string, unknown>} [acquireCtx]
 * @property {boolean} [acquired]
 * @property {object} connectionCtx
 * @property {unknown} [error]
 * @property {boolean} [errorReported]
 * @property {boolean} [finished]
 * @property {boolean} measure
 * @property {object} options
 * @property {object} pool
 * @property {object} [queryCtx]
 * @property {boolean} [queryStarted]
 * @property {boolean} [ready]
 * @property {number} [start]
 */
/** @typedef {import('node:async_hooks').AsyncLocalStorage<PoolAcquisition>} PoolAcquisitionStorage */
/** @typedef {{ acquisitions: Array<PoolAcquisition | undefined>, index: number }} PendingPoolAcquisitions */

/** @type {ClusterSelectionStorage | undefined} */
let clusterSelectionStorage

/** @type {PoolAcquisitionStorage | undefined} */
let poolAcquisitionStorage

/** @type {WeakMap<object, PendingPoolAcquisitions>} */
const pendingPoolAcquisitions = new WeakMap()

/**
 * Creates cluster selection storage only when an application uses pool clusters.
 *
 * @returns {ClusterSelectionStorage}
 */
function getClusterSelectionStorage () {
  if (clusterSelectionStorage === undefined) {
    const { AsyncLocalStorage } = require('node:async_hooks')
    clusterSelectionStorage = new AsyncLocalStorage()
  }
  return clusterSelectionStorage
}

/**
 * Creates pool acquisition storage only when an application uses a bundled pool.
 *
 * @returns {PoolAcquisitionStorage}
 */
function getPoolAcquisitionStorage () {
  if (poolAcquisitionStorage === undefined) {
    const { AsyncLocalStorage } = require('node:async_hooks')
    poolAcquisitionStorage = new AsyncLocalStorage()
  }
  return poolAcquisitionStorage
}

/**
 * Extracts SQL from MariaDB's string and object command forms.
 *
 * @param {unknown} command
 * @returns {unknown}
 */
function normalizeSql (command) {
  return command?.sql ?? command
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
 * Creates acquisition state while the caller context is still active.
 *
 * @param {object} pool
 * @param {object} options
 * @param {object} [queryCtx]
 * @param {'explicit' | 'measure' | 'observe'} mode
 * @returns {PoolAcquisition}
 */
function createPoolAcquisition (pool, options, queryCtx, mode) {
  const explicit = mode === 'explicit'
  const measure = explicit || mode === 'measure'
  const connectionCtx = measure || queryCtx !== undefined ? {} : emptyConnectionContext
  const acquisition = { connectionCtx, measure, options, pool, queryCtx }

  if (connectionCtx !== emptyConnectionContext) connectionStartCh.publish(connectionCtx)
  if (explicit) {
    acquisition.acquireCtx = { conf: options }
    acquireStartCh.publish(acquisition.acquireCtx)
  }

  return acquisition
}

/**
 * Queues a delayed acquisition for pool events that no longer carry its async-local context.
 *
 * @param {PoolAcquisition} acquisition
 * @returns {void}
 */
function queuePoolAcquisition (acquisition) {
  let pending = pendingPoolAcquisitions.get(acquisition.pool)
  if (pending === undefined) {
    pending = { acquisitions: [], index: 0 }
    pendingPoolAcquisitions.set(acquisition.pool, pending)
  }
  pending.acquisitions.push(acquisition)
}

/**
 * Reports whether an acquisition still needs a matching pool event.
 *
 * @param {PoolAcquisition} acquisition
 * @returns {boolean}
 */
function isPoolAcquisitionPending (acquisition) {
  return !acquisition.acquired && !acquisition.finished && !acquisition.errorReported
}

/**
 * Releases a consumed acquisition and periodically compacts its queue.
 *
 * @param {PendingPoolAcquisitions} pending
 * @returns {void}
 */
function discardPoolAcquisition (pending) {
  pending.acquisitions[pending.index++] = undefined

  if (
    pending.index < POOL_ACQUISITION_COMPACTION_THRESHOLD ||
    pending.index * 2 < pending.acquisitions.length ||
    pending.index === pending.acquisitions.length
  ) {
    return
  }

  pending.acquisitions = pending.acquisitions.slice(pending.index)
  pending.index = 0
}

/**
 * Removes completed entries from the front of a pool's acquisition queue.
 *
 * @param {object} pool
 * @returns {void}
 */
function prunePoolAcquisitions (pool) {
  const pending = pendingPoolAcquisitions.get(pool)
  if (pending === undefined) return

  while (pending.index < pending.acquisitions.length) {
    const acquisition = /** @type {PoolAcquisition} */ (pending.acquisitions[pending.index])
    if (isPoolAcquisitionPending(acquisition)) return

    discardPoolAcquisition(pending)
  }

  pendingPoolAcquisitions.delete(pool)
}

/**
 * Takes the next unfinished acquisition from a pool's public-operation queue.
 *
 * @param {object} pool
 * @returns {PoolAcquisition | undefined}
 */
function takePoolAcquisition (pool) {
  const pending = pendingPoolAcquisitions.get(pool)
  if (pending === undefined) return

  while (pending.index < pending.acquisitions.length) {
    const acquisition = /** @type {PoolAcquisition} */ (pending.acquisitions[pending.index])
    discardPoolAcquisition(pending)

    if (isPoolAcquisitionPending(acquisition)) return acquisition
  }

  pendingPoolAcquisitions.delete(pool)
}

/**
 * Records the pool wait when MariaDB announces that the calling operation acquired a connection.
 *
 * @param {object} pool
 * @returns {void}
 */
function recordPoolAcquisition (pool) {
  let acquisition = poolAcquisitionStorage?.getStore()
  if (acquisition?.pool !== pool || !isPoolAcquisitionPending(acquisition)) {
    acquisition = takePoolAcquisition(pool)
  }
  if (acquisition === undefined) return

  acquisition.acquired = true
  prunePoolAcquisitions(pool)
  if (!acquisition.measure) {
    startPoolCommand(acquisition)
    return
  }

  const poolWaitTime = acquireWait(acquisition.start)

  if (acquisition.queryCtx !== undefined) acquisition.queryCtx.poolWaitTime = poolWaitTime
  if (acquisition.acquireCtx !== undefined) acquisition.acquireCtx.poolWaitTime = poolWaitTime

  startPoolCommand(acquisition)
}

/**
 * Starts a pooled command after MariaDB has acquired the connection that will execute it.
 *
 * @param {PoolAcquisition} acquisition
 * @returns {void}
 */
function startPoolCommand (acquisition) {
  const queryCtx = acquisition.queryCtx
  if (queryCtx === undefined || acquisition.queryStarted) return

  acquisition.queryStarted = true
  connectionFinishCh.runStores(acquisition.connectionCtx, runCommandStart, undefined, queryCtx)
}

/**
 * Starts a command lifecycle without running connector work inside its span store.
 *
 * @param {object} ctx
 * @returns {void}
 */
function runCommandStart (ctx) {
  startCh.runStores(ctx, noop)
}

/**
 * Creates an acquire error span when a pooled query fails before receiving a connection.
 *
 * @param {PoolAcquisition | undefined} acquisition
 * @param {unknown} error
 * @returns {void}
 */
function reportPoolQueryAcquireError (acquisition, error) {
  if (acquisition === undefined || acquisition.acquired || acquisition.errorReported) return

  acquisition.error = error
  if (!acquisition.ready) return

  acquisition.errorReported = true
  prunePoolAcquisitions(acquisition.pool)
  connectionFinishCh.runStores(acquisition.connectionCtx, reportPoolAcquireError, undefined,
    acquisition.start, error, { conf: acquisition.options }, poolAcquireChannels)
}

/**
 * Calls a method with its original receiver and arguments.
 *
 * @param {Function} method
 * @param {unknown} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function callMethod (method, receiver, args) {
  return method.apply(receiver, args)
}

/**
 * Runs a public pool operation while associating its acquire event with that operation.
 *
 * @param {PoolAcquisition} acquisition
 * @param {Function} method
 * @param {object} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runPoolAcquisition (acquisition, method, receiver, args) {
  const result = getPoolAcquisitionStorage().run(acquisition, callMethod, method, receiver, args)

  acquisition.ready = true
  if (!acquisition.acquired && !acquisition.finished) {
    queuePoolAcquisition(acquisition)
    if (!acquisition.measure) return result

    if (acquisition.error === undefined) {
      acquisition.start = performance.now()
    } else {
      reportPoolQueryAcquireError(acquisition, acquisition.error)
    }
  }

  return result
}

/**
 * Completes tracking for a pool command that has returned to the caller.
 *
 * @param {PoolAcquisition | undefined} acquisition
 * @param {unknown} [error]
 * @returns {void}
 */
function finishPoolCommandAcquisition (acquisition, error) {
  if (acquisition === undefined) return
  if (error && acquisition.measure) {
    reportPoolQueryAcquireError(acquisition, error)
    if (!acquisition.ready) return
  }
  if (!acquisition.acquired) acquisition.finished = true
  prunePoolAcquisitions(acquisition.pool)
}

/**
 * Runs a bundled pool method in the instrumentation skip context.
 *
 * @param {Function} method
 * @param {unknown} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runSkippedPoolMethod (method, receiver, args) {
  return skipCh.runStores({}, method, receiver, ...args)
}

/**
 * Finishes the acquire span created for a public getConnection call.
 *
 * @param {PoolAcquisition} acquisition
 * @param {unknown} [error]
 * @returns {void}
 */
function finishExplicitPoolAcquisition (acquisition, error) {
  if (acquisition.finished) return
  acquisition.finished = true
  prunePoolAcquisitions(acquisition.pool)

  const acquireCtx = acquisition.acquireCtx
  if (acquireCtx === undefined) return

  acquireCtx.poolWaitTime ??= acquireWait(acquisition.start)
  if (error) acquireCtx.error = error
  acquireFinishCh.publish(acquireCtx)
}

/**
 * Restores the acquisition observer if application listener cleanup removed it.
 *
 * @param {object} pool
 * @param {Function} observer
 * @returns {void}
 */
function restorePoolAcquisitionObserver (pool, observer) {
  const listeners = pool.listeners('acquire')
  for (const listener of listeners) {
    if (listener === observer) return
  }
  pool.prependListener('acquire', observer)
}

/**
 * Observes public acquire events forwarded by a bundled pool.
 *
 * @param {object} pool
 * @returns {void}
 */
function observePoolAcquisitions (pool) {
  const observer = () => {
    if (connectionStartCh.hasSubscribers) recordPoolAcquisition(pool)
  }
  pool.prependListener('acquire', observer)

  shimmer.wrap(pool, 'removeAllListeners', removeAllListeners => function (event) {
    const result = removeAllListeners.apply(this, arguments)
    if (event === undefined || event === 'acquire') restorePoolAcquisitionObserver(pool, observer)
    return result
  })
}

/**
 * Marks a command as active on its owning public connection.
 *
 * @param {object | undefined} owner
 * @returns {void}
 */
function startCommand (owner) {
  if (owner === undefined) return
  activeCommands.set(owner, (activeCommands.get(owner) ?? 0) + 1)
}

/**
 * Releases one active command without clearing concurrent commands.
 *
 * @param {object | undefined} owner
 * @returns {void}
 */
function endCommand (owner) {
  if (owner === undefined) return
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
 * @param {object | undefined} owner
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
 * @param {object | undefined} owner
 * @param {Error} [error]
 * @param {unknown} [result]
 * @returns {void}
 */
function finishCommand (ctx, owner, error, result) {
  finishCommandState(ctx, owner, error, result)
  finishCh.publish(ctx)
}

/**
 * Replaces an existing callback or inserts one in the method's declared callback slot.
 *
 * @param {ArgumentsLike} args
 * @param {number} callbackIndex
 * @param {unknown} callback
 * @param {(callback?: Function) => Function} createCallback
 * @returns {void}
 */
function setCommandCallback (args, callbackIndex, callback, createCallback) {
  if (typeof callback === 'function') {
    args[args.length - 1] = shimmer.wrapCallback(callback, createCallback)
    return
  }

  const wrappedCallback = createCallback()
  // MariaDB reads the declared callback slot, so appending after an explicit null leaves the wrapper unused.
  if (callbackIndex >= 0 && args.length > callbackIndex && args[callbackIndex] == null) {
    args[callbackIndex] = wrappedCallback
    return
  }

  args.length = Math.max(args.length + 1, callbackIndex + 1)
  args[args.length - 1] = wrappedCallback
}

/**
 * Tracks an untraced promise command while MariaDB may have work queued for it.
 *
 * @param {Function} command
 * @returns {Function}
 */
function createTrackPromiseCommand (command) {
  return function () {
    if (!startCh.hasSubscribers) return command.apply(this, arguments)

    const owner = this
    startCommand(owner)

    let result
    try {
      result = command.apply(this, arguments)
    } catch (error) {
      endCommand(owner)
      throw error
    }

    return result.then(result => {
      endCommand(owner)
      return result
    }, error => {
      endCommand(owner)
      throw error
    })
  }
}

/**
 * Tracks an untraced callback command while MariaDB may have work queued for it.
 *
 * @param {Function} command
 * @returns {Function}
 */
function createTrackCallbackCommand (command) {
  const callbackIndex = command.length - 1

  return function () {
    if (!startCh.hasSubscribers) return command.apply(this, arguments)

    const owner = this
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      endCommand(owner)
    }
    const createCallback = callback => function () {
      finish()
      if (typeof callback === 'function') return callback.apply(this, arguments)
    }

    const callback = arguments[arguments.length - 1]
    setCommandCallback(arguments, callbackIndex, callback, createCallback)
    startCommand(owner)

    try {
      return command.apply(this, arguments)
    } catch (error) {
      finish()
      throw error
    }
  }
}

/**
 * Creates a promise-returning command wrapper.
 *
 * @param {object} options
 * @param {unknown} [preparedSql]
 * @param {object} [commandOwner]
 * @param {number} [_commandArity] Reserved for callback command wrappers.
 * @param {boolean} [trackActiveCommands]
 * @param {'measure' | 'observe'} [poolAcquisition]
 * @returns {(command: Function) => Function}
 */
function createWrapPromiseCommand (
  options,
  preparedSql,
  commandOwner,
  _commandArity,
  trackActiveCommands = true,
  poolAcquisition
) {
  return function wrapCommand (command) {
    return function (sql) {
      if (!startCh.hasSubscribers) return command.apply(this, arguments)

      const owner = trackActiveCommands ? (commandOwner ?? this) : undefined
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }
      const acquisition = poolAcquisition === undefined
        ? undefined
        : createPoolAcquisition(this, options, ctx, poolAcquisition)

      startCommand(owner)

      let result
      try {
        result = acquisition === undefined
          ? startCh.runStores(ctx, command, this, ...arguments)
          : runPoolAcquisition(acquisition, command, this, arguments)
      } catch (error) {
        finishPoolCommandAcquisition(acquisition, error)
        if (acquisition === undefined || acquisition.queryStarted) finishCommand(ctx, owner, error)
        throw error
      }

      return result.then(result => {
        finishPoolCommandAcquisition(acquisition)
        if (acquisition === undefined || acquisition.queryStarted) finishCommand(ctx, owner, undefined, result)
        return result
      }, error => {
        finishPoolCommandAcquisition(acquisition, error)
        if (acquisition === undefined || acquisition.queryStarted) finishCommand(ctx, owner, error)
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
 * @param {boolean} [trackActiveCommands]
 * @param {'measure' | 'observe'} [poolAcquisition]
 * @returns {(command: Function) => Function}
 */
function createWrapCallbackCommand (
  options,
  preparedSql,
  commandOwner,
  commandArity,
  trackActiveCommands = true,
  poolAcquisition
) {
  return function wrapCommand (command) {
    const callbackIndex = (commandArity ?? command.length) - 1

    return function (sql) {
      if (!startCh.hasSubscribers) return command.apply(this, arguments)

      const owner = trackActiveCommands ? (commandOwner ?? this) : undefined
      const callback = arguments[arguments.length - 1]
      const ctx = { sql: preparedSql ?? normalizeSql(sql), conf: options }
      const acquisition = poolAcquisition === undefined
        ? undefined
        : createPoolAcquisition(this, options, ctx, poolAcquisition)
      const wrapper = callback => function (error) {
        finishPoolCommandAcquisition(acquisition, error)
        if (acquisition !== undefined && !acquisition.queryStarted) {
          return typeof callback === 'function'
            ? connectionFinishCh.runStores(acquisition.connectionCtx, callback, this, ...arguments)
            : undefined
        }

        finishCommandState(ctx, owner, error)

        return typeof callback === 'function'
          ? finishCh.runStores(ctx, callback, this, ...arguments)
          : finishCh.runStores(ctx, noop, this)
      }

      setCommandCallback(arguments, callbackIndex, callback, wrapper)

      startCommand(owner)

      try {
        return acquisition === undefined
          ? startCh.runStores(ctx, command, this, ...arguments)
          : runPoolAcquisition(acquisition, command, this, arguments)
      } catch (error) {
        finishPoolCommandAcquisition(acquisition, error)
        if (acquisition === undefined || acquisition.queryStarted) finishCommand(ctx, owner, error)
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
 * Wraps commands exposed by a bundled pool and tracks acquisition for query and execute.
 *
 * @param {object} pool
 * @param {object} options
 * @param {(options: object, sql?: unknown, owner?: object, commandArity?: number,
 *   trackActiveCommands?: boolean, poolAcquisition?: 'measure' | 'observe') =>
 *   (command: Function) => Function} createWrapper
 * @returns {void}
 */
function wrapPoolCommands (pool, options, createWrapper) {
  if (wrappedClients.has(pool)) return

  wrappedClients.add(pool)
  for (const method of commandMethods) {
    if (typeof pool[method] !== 'function') continue
    const poolAcquisition = method === 'query' || method === 'execute' ? 'measure' : 'observe'
    shimmer.wrap(pool, method, createWrapPoolCommand(options, createWrapper, undefined, poolAcquisition))
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
    const wrapCommand = createWrapper(options, sql, undefined, transaction.length)
    const tracedTransaction = wrapCommand(function () {
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
  for (const method of trackedCommandMethods) {
    if (typeof connection[method] === 'function') shimmer.wrap(connection, method, createTrackPromiseCommand)
  }
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
  for (const method of trackedCommandMethods) {
    if (typeof connection[method] === 'function') shimmer.wrap(connection, method, createTrackCallbackCommand)
  }
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
    const wrapCallbackCommand = createWrapCallbackCommand(options, sql, connection)
    const wrapPromiseCommand = createWrapPromiseCommand(options, sql, connection)
    const executeWithCallback = wrapCallbackCommand(execute)
    const executeWithPromise = wrapPromiseCommand(execute)

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
 * @param {(options: object, sql?: unknown, owner?: object, commandArity?: number,
 *   trackActiveCommands?: boolean, poolAcquisition?: 'measure' | 'observe') =>
 *   (command: Function) => Function} createWrapper
 * @param {unknown} [preparedSql]
 * @param {'measure' | 'observe'} [poolAcquisition]
 * @returns {(command: Function) => Function}
 */
function createWrapPoolCommand (options, createWrapper, preparedSql, poolAcquisition) {
  return function wrapPoolCommand (command) {
    const wrapCommand = createWrapper(options, preparedSql, undefined, command.length, false, poolAcquisition)
    return wrapCommand(function () {
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
 * Finishes an explicit promise acquisition and instruments its connection in the caller context.
 *
 * @param {PoolAcquisition} acquisition
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function finishExplicitPromiseGetConnection (acquisition, connection, options) {
  return connectionFinishCh.runStores(acquisition.connectionCtx, () => {
    finishExplicitPoolAcquisition(acquisition)
    return wrapPromiseConnection(connection, options)
  })
}

/**
 * Finishes a failed explicit promise acquisition in the caller context.
 *
 * @param {PoolAcquisition} acquisition
 * @param {Error} error
 * @throws {Error} The connection acquisition error.
 */
function finishExplicitPromiseGetConnectionError (acquisition, error) {
  return connectionFinishCh.runStores(acquisition.connectionCtx, () => {
    finishExplicitPoolAcquisition(acquisition, error)
    throw error
  })
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
      if (!connectionStartCh.hasSubscribers) return getConnection.apply(this, arguments)

      if (!acquireStartCh.hasSubscribers) {
        const ctx = {}
        connectionStartCh.publish(ctx)
        return skipCh.runStores({}, getConnection, this, ...arguments).then(
          connection => finishPromiseGetConnection(ctx, connection, options),
          error => finishPromiseGetConnectionError(ctx, error)
        )
      }

      const acquisition = createPoolAcquisition(this, options, undefined, 'explicit')
      let result

      try {
        result = runPoolAcquisition(acquisition, runSkippedPoolMethod, undefined, [getConnection, this, arguments])
      } catch (error) {
        return finishExplicitPromiseGetConnectionError(acquisition, error)
      }

      return result.then(
        connection => finishExplicitPromiseGetConnection(acquisition, connection, options),
        error => finishExplicitPromiseGetConnectionError(acquisition, error)
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

      if (!connectionStartCh.hasSubscribers) return getConnection.apply(this, arguments)

      if (!acquireStartCh.hasSubscribers) {
        const ctx = {}
        arguments[arguments.length - 1] = function () {
          const connection = arguments[1]
          if (connection) wrapCallbackConnection(connection, options)
          return connectionFinishCh.runStores(ctx, callback, this, ...arguments)
        }

        connectionStartCh.publish(ctx)
        return skipCh.runStores({}, getConnection, this, ...arguments)
      }

      const acquisition = createPoolAcquisition(this, options, undefined, 'explicit')
      arguments[arguments.length - 1] = function (error, connection) {
        if (connection) wrapCallbackConnection(connection, options)
        return connectionFinishCh.runStores(acquisition.connectionCtx, () => {
          finishExplicitPoolAcquisition(acquisition, error)
          return callback.apply(this, arguments)
        })
      }

      try {
        return runPoolAcquisition(acquisition, runSkippedPoolMethod, undefined, [getConnection, this, arguments])
      } catch (error) {
        return finishExplicitPromiseGetConnectionError(acquisition, error)
      }
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
 * @param {ClusterSelectionStorage} selectionStorage
 * @returns {void}
 */
function captureClusterOptions (cluster, defaultOptions, selectionStorage) {
  /** @type {Map<string, ClusterNodeOptions>} */
  const optionsByIdentifier = new Map()
  let nodeCounter = 0

  const removeOptions = identifier => {
    const nodeOptions = optionsByIdentifier.get(identifier)
    if (nodeOptions?.pendingRemovals) {
      nodeOptions.pendingRemovals--
    } else {
      optionsByIdentifier.delete(identifier)
    }
  }

  // ClusterCallback.on is bound to its private Cluster, so EventEmitter returns the internal
  // runtime object for both APIs. MariaDB does not expose the selected node on the returned
  // connection; capture _selectPool while the acquisition's async-local selection is active.
  const internalCluster = cluster.on('remove', removeOptions)
  if (typeof internalCluster._selectPool === 'function') {
    shimmer.wrap(internalCluster, '_selectPool', selectPool => function () {
      const identifier = selectPool.apply(this, arguments)
      const selection = selectionStorage.getStore()
      if (selection !== undefined) selection.options = optionsByIdentifier.get(identifier)?.options
      return identifier
    })
  }

  shimmer.wrap(cluster, 'add', add => function (identifier, options) {
    const hasIdentifier = typeof identifier === 'string' ||
      Object.prototype.toString.call(identifier) === '[object String]'
    const generatedIdentifier = hasIdentifier ? String(identifier) : `PoolNode-${nodeCounter++}`
    const connectionOptions = hasIdentifier ? options : identifier
    const result = skipCh.runStores({}, add, this, ...arguments)
    const previousNodeOptions = optionsByIdentifier.get(generatedIdentifier)

    // MariaDB deletes a failed node before emitting its delayed remove event. A successful
    // same-identifier add while options remain therefore adds one stale event to ignore.
    const nodeOptions = {
      options: normalizeOptions(defaultOptions, connectionOptions),
      pendingRemovals: previousNodeOptions === undefined ? 0 : previousNodeOptions.pendingRemovals + 1,
    }
    optionsByIdentifier.set(generatedIdentifier, nodeOptions)

    return result
  })

  shimmer.wrap(cluster, 'remove', remove => function (pattern) {
    const result = remove.apply(this, arguments)
    removeClusterOptions(optionsByIdentifier, pattern)
    return result
  })

  shimmer.wrap(cluster, 'end', end => function () {
    const result = end.apply(this, arguments)
    optionsByIdentifier.clear()
    internalCluster.removeListener('remove', removeOptions)
    return result
  })
}

/**
 * Removes options for every cluster node matching a selector.
 *
 * @param {Map<string, ClusterNodeOptions>} optionsByIdentifier
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
 * Calls a cluster acquisition inside the pool-skip context while selection storage is active.
 *
 * @param {Function} getConnection
 * @param {object} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runClusterGetConnection (getConnection, receiver, args) {
  return skipCh.runStores({}, getConnection, receiver, ...args)
}

/**
 * Reports a failed bundled cluster node acquisition.
 *
 * @param {ClusterSelection} selection
 * @param {number | undefined} start
 * @param {unknown} error
 * @returns {void}
 */
function reportBundledClusterAcquireError (selection, start, error) {
  if (!acquireStartCh.hasSubscribers) return
  reportPoolAcquireError(start, error, { conf: selection.options ?? emptyOptions }, poolAcquireChannels)
}

/**
 * Restores promise caller context and reports a failed bundled cluster node acquisition.
 *
 * @param {object} ctx
 * @param {ClusterSelection} selection
 * @param {number | undefined} start
 * @param {unknown} error
 * @throws {unknown} The connection acquisition error.
 */
function finishPromiseClusterGetConnectionError (ctx, selection, start, error) {
  return connectionFinishCh.runStores(ctx, () => {
    reportBundledClusterAcquireError(selection, start, error)
    throw error
  })
}

/**
 * Restores callback caller context and finishes a bundled cluster acquisition.
 *
 * @param {ClusterSelection} selection
 * @param {number | undefined} start
 * @param {Function} callback
 * @param {unknown} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function finishCallbackClusterGetConnection (selection, start, callback, receiver, args) {
  const error = args[0]
  const connection = args[1]
  if (error) reportBundledClusterAcquireError(selection, start, error)
  if (connection) wrapCallbackConnection(connection, selection.options ?? emptyOptions)
  return callback.apply(receiver, args)
}

/**
 * Wraps promise connections acquired from a bundled pool cluster.
 *
 * @param {ClusterSelectionStorage} selectionStorage
 * @returns {(getConnection: Function) => Function}
 */
function createWrapPromiseClusterGetConnection (selectionStorage) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const ctx = {}
      /** @type {ClusterSelection} */
      const selection = {}
      const start = acquireStartCh.hasSubscribers ? performance.now() : undefined

      connectionStartCh.publish(ctx)

      const result = selectionStorage.run(
        selection,
        runClusterGetConnection,
        getConnection,
        this,
        arguments
      )

      return result.then(
        connection => finishPromiseGetConnection(ctx, connection, selection.options ?? emptyOptions),
        error => finishPromiseClusterGetConnectionError(ctx, selection, start, error)
      )
    }
  }
}

/**
 * Wraps callback connections acquired from a bundled pool cluster.
 *
 * @param {ClusterSelectionStorage} selectionStorage
 * @returns {(getConnection: Function) => Function}
 */
function createWrapCallbackClusterGetConnection (selectionStorage) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const callback = arguments[arguments.length - 1]
      if (typeof callback !== 'function') return getConnection.apply(this, arguments)

      const ctx = {}
      /** @type {ClusterSelection} */
      const selection = {}
      const start = acquireStartCh.hasSubscribers ? performance.now() : undefined
      arguments[arguments.length - 1] = function () {
        return connectionFinishCh.runStores(
          ctx,
          finishCallbackClusterGetConnection,
          undefined,
          selection,
          start,
          callback,
          this,
          arguments
        )
      }

      connectionStartCh.publish(ctx)

      return selectionStorage.run(
        selection,
        runClusterGetConnection,
        getConnection,
        this,
        arguments
      )
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
  const selectionStorage = getClusterSelectionStorage()
  captureClusterOptions(cluster, defaultOptions, selectionStorage)

  shimmer.wrap(cluster, 'getConnection', createWrapPromiseClusterGetConnection(selectionStorage))

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
  const selectionStorage = getClusterSelectionStorage()
  captureClusterOptions(cluster, defaultOptions, selectionStorage)

  shimmer.wrap(cluster, 'getConnection', createWrapCallbackClusterGetConnection(selectionStorage))
  // The filtered callback facade delegates to a private Cluster instance, bypassing the public method above.
  shimmer.wrap(cluster, 'of', of => function () {
    const filteredCluster = of.apply(this, arguments)
    shimmer.wrap(filteredCluster, 'getConnection', createWrapCallbackClusterGetConnection(selectionStorage))
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

      observePoolAcquisitions(pool)
      wrapPoolConnectionEvent(pool, normalizedOptions, wrapPromiseConnection)
      wrapPoolCommands(pool, normalizedOptions, createWrapPromiseCommand)
      shimmer.wrap(
        pool,
        'importFile',
        createWrapPoolCommand(normalizedOptions, createWrapPromiseCommand, IMPORT_FILE_RESOURCE, 'observe')
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

      observePoolAcquisitions(pool)
      wrapPoolConnectionEvent(pool, normalizedOptions, wrapCallbackConnection)
      wrapPoolCommands(pool, normalizedOptions, createWrapCallbackCommand)
      shimmer.wrap(
        pool,
        'importFile',
        createWrapPoolCommand(normalizedOptions, createWrapCallbackCommand, IMPORT_FILE_RESOURCE, 'observe')
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
      const wrapCommand = createWrapPromiseCommand(
        normalizeOptions(defaultOptions, options),
        IMPORT_FILE_RESOURCE,
        undefined,
        undefined,
        false
      )
      const wrapper = wrapCommand(importFile)
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
      const wrapCommand = createWrapCallbackCommand(
        normalizeOptions(defaultOptions, options),
        IMPORT_FILE_RESOURCE,
        undefined,
        undefined,
        false
      )
      const wrapper = wrapCommand(importFile)
      return wrapper.apply(this, arguments)
    }
  }
}

/**
 * Wraps selected CommonJS factories in the mutable default export and its non-configurable namespace getters.
 *
 * @param {object} mariadb
 * @param {Array<[string, (factory: Function) => Function]>} factories
 * @returns {object}
 */
function wrapBundle (mariadb, factories) {
  const defaultExport = mariadb.default
  let wrappedBundle = mariadb

  for (const [name, wrapper] of factories) {
    wrappedBundle = shimmer.wrap(wrappedBundle, name, wrapper, { replaceGetter: true })
  }
  for (const [name] of factories) {
    shimmer.wrap(defaultExport, name, () => wrappedBundle[name])
  }

  return wrappedBundle
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
