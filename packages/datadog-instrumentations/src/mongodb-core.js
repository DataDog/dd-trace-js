'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
  AsyncResource,
} = require('./helpers/instrument')

const startCh = channel('apm:mongodb:query:start')
const finishCh = channel('apm:mongodb:query:finish')
const errorCh = channel('apm:mongodb:query:error')

// Per-Connection cached topology shape (mongodb >= 4). The Connection's `address` is immutable
// for the lifetime of the connection, so we synthesize the `{ s: { options } }` envelope the
// plugin expects only once per connection. A WeakMap keeps the cache off the foreign Connection
// instance — no extra own-key visible to `Reflect.ownKeys`, `Object.freeze`, or another tracer's
// instrumentation walking the connection.
/** @type {WeakMap<object, { s: { options: { host?: string, port?: string } } }>} */
const topologyCache = new WeakMap()

addHook({ name: 'mongodb-core', versions: ['2 - 3.1.9'] }, Server => {
  const serverProto = Server.Server.prototype
  shimmer.wrap(serverProto, 'command', command => wrapCommand(command, 'command'))
  shimmer.wrap(serverProto, 'insert', insert => wrapCommand(insert, 'insert', 'insert'))
  shimmer.wrap(serverProto, 'update', update => wrapCommand(update, 'update', 'update'))
  shimmer.wrap(serverProto, 'remove', remove => wrapCommand(remove, 'remove', 'remove'))

  const cursorProto = Server.Cursor.prototype
  shimmer.wrap(cursorProto, '_getmore', _getmore => wrapCursor(_getmore, 'getMore', 'getMore'))
  shimmer.wrap(cursorProto, '_find', _find => wrapQuery(_find, '_find'))
  shimmer.wrap(cursorProto, 'kill', kill => wrapCursor(kill, 'killCursors', 'killCursors'))
})

addHook({ name: 'mongodb', versions: ['>=4 <4.6.0'], file: 'lib/cmap/connection.js' }, Connection => {
  const proto = Connection.Connection.prototype
  shimmer.wrap(proto, 'command', command => wrapConnectionCommand(command, 'command'))
  shimmer.wrap(proto, 'query', query => wrapConnectionCommand(query, 'query'))
})

addHook({ name: 'mongodb', versions: ['>=4.6.0 <6.4.0'], file: 'lib/cmap/connection.js' }, Connection => {
  const proto = Connection.Connection.prototype
  shimmer.wrap(proto, 'command', command => wrapConnectionCommand(command, 'command'))
})

addHook({ name: 'mongodb', versions: ['>=6.4.0'], file: 'lib/cmap/connection.js' }, Connection => {
  const proto = Connection.Connection.prototype
  shimmer.wrap(proto, 'command', command => wrapConnectionCommand(command, 'command', undefined, instrumentPromise))
})

addHook({ name: 'mongodb', versions: ['>=3.3 <4'], file: 'lib/core/wireprotocol/index.js' }, wp => wrapWp(wp))

addHook({ name: 'mongodb-core', versions: ['>=3.2'], file: 'lib/wireprotocol/index.js' }, wp => wrapWp(wp))

addHook({ name: 'mongodb-core', versions: ['~3.1.10'], file: 'lib/wireprotocol/3_2_support.js' }, WireProtocol => {
  shimmer.wrap(WireProtocol.prototype, 'command', command => wrapUnifiedCommand(command, 'command'))
})

addHook({ name: 'mongodb-core', versions: ['~3.1.10'], file: 'lib/wireprotocol/2_6_support.js' }, WireProtocol => {
  shimmer.wrap(WireProtocol.prototype, 'command', command => wrapUnifiedCommand(command, 'command'))
})

addHook({ name: 'mongodb', versions: ['>=3.5.4 <4.11.0'], file: 'lib/utils.js' }, util => {
  shimmer.wrap(util, 'maybePromise', maybePromise => function (parent, callback, fn) {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const callbackIndex = arguments.length - 2

    callback = arguments[callbackIndex]

    if (typeof callback === 'function') {
      arguments[callbackIndex] = asyncResource.bind(callback)
    }

    return maybePromise.apply(this, arguments)
  })
})

function wrapWp (wp) {
  shimmer.wrap(wp, 'command', command => wrapUnifiedCommand(command, 'command'))
  shimmer.wrap(wp, 'insert', insert => wrapUnifiedCommand(insert, 'insert', 'insert'))
  shimmer.wrap(wp, 'update', update => wrapUnifiedCommand(update, 'update', 'update'))
  shimmer.wrap(wp, 'remove', remove => wrapUnifiedCommand(remove, 'remove', 'remove'))
  shimmer.wrap(wp, 'query', query => wrapUnifiedCommand(query, 'query'))
  shimmer.wrap(wp, 'getMore', getMore => wrapUnifiedCommand(getMore, 'getMore', 'getMore'))
  shimmer.wrap(wp, 'killCursors', killCursors => wrapUnifiedCommand(killCursors, 'killCursors', 'killCursors'))
  return wp
}

function wrapUnifiedCommand (command, operation, name) {
  return function (server, ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    return instrument(operation, command, this, arguments, server, ns, ops, { name })
  }
}

function wrapConnectionCommand (command, operation, name, instrumentFn = instrument) {
  const opts = { name }
  return function (ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    let topology = topologyCache.get(this)
    if (topology === undefined) {
      topology = synthesizeTopology(this.address)
      topologyCache.set(this, topology)
    }
    return instrumentFn(operation, command, this, arguments, topology, `${ns.db}.${ns.collection}`, ops, opts)
  }
}

/**
 * @param {string} address
 * @returns {{ s: { options: { host?: string, port?: string } } }}
 */
function synthesizeTopology (address) {
  if (typeof address === 'string') {
    const colon = address.indexOf(':')
    // Match the previous `.split(':')` length-2 check: exactly one colon with non-empty parts on both sides.
    if (colon > 0 && colon < address.length - 1 && !address.includes(':', colon + 1)) {
      return { s: { options: { host: address.slice(0, colon), port: address.slice(colon + 1) } } }
    }
  }
  // No port means the address is a random UUID, an IPv6 form, or otherwise unparseable, so no host either.
  return { s: { options: {} } }
}

function wrapQuery (query, operation, name) {
  return function (...args) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, args)
    }
    const pool = this.server.s.pool
    const ns = this.ns
    const ops = this.cmd
    return instrument(operation, query, this, args, pool, ns, ops)
  }
}

function wrapCursor (cursor, operation, name) {
  return function (...args) {
    if (!startCh.hasSubscribers) {
      return cursor.apply(this, args)
    }
    const pool = this.server.s.pool
    const ns = this.ns
    return instrument(operation, cursor, this, args, pool, ns, {}, { name })
  }
}

function wrapCommand (command, operation, name) {
  return function (ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    return instrument(operation, command, this, arguments, this, ns, ops, { name })
  }
}

function instrument (operation, command, instance, args, server, ns, ops, options = {}) {
  const name = options.name || (ops && Object.keys(ops)[0])
  const index = args.length - 1
  const callback = args[index]

  if (typeof callback !== 'function') return command.apply(instance, args)

  const serverInfo = server && server.s && server.s.options

  const ctx = {
    ns,
    ops,
    options: serverInfo,
    name,
  }
  return startCh.runStores(ctx, () => {
    args[index] = shimmer.wrapCallback(callback, callback => function (err, res) {
      if (err) {
        ctx.error = err
        errorCh.publish(ctx)
      }

      return finishCh.runStores(ctx, callback, this, ...arguments)
    })

    try {
      return command.apply(instance, args)
    } catch (err) {
      ctx.error = err
      errorCh.publish(ctx)

      throw err
    }
  })
}

module.exports = { synthesizeTopology }

function instrumentPromise (operation, command, instance, args, server, ns, ops, options = {}) {
  const name = options.name || (ops && Object.keys(ops)[0])

  const serverInfo = server && server.s && server.s.options

  const ctx = {
    ns,
    ops,
    options: serverInfo,
    name,
  }

  return startCh.runStores(ctx, () => {
    const promise = command.apply(instance, args)

    promise.then(function (res) {
      ctx.result = res
      finishCh.publish(ctx)
    }, function (err) {
      ctx.error = err
      errorCh.publish(ctx)
      finishCh.publish(ctx)
    })

    return promise
  })
}
