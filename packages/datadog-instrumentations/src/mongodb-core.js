'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel(`apm:mongodb:query:start`)
const finishCh = channel(`apm:mongodb:query:finish`)
const errorCh = channel(`apm:mongodb:query:error`)

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
  return Server
})

addHook({ name: 'mongodb', versions: ['>=4'], file: 'lib/cmap/connection.js' }, Connection => {
  const proto = Connection.Connection.prototype
  shimmer.wrap(proto, 'command', command => wrapConnectionCommand(command, 'command'))
  shimmer.wrap(proto, 'query', query => wrapConnectionCommand(query, 'query'))
  return Connection
})

addHook({ name: 'mongodb', versions: ['>=3.3 <4'], file: 'lib/core/wireprotocol/index.js' }, wp => wrapWp(wp))

addHook({ name: 'mongodb-core', versions: ['>=3.2'], file: 'lib/wireprotocol/index.js' }, wp => wrapWp(wp))

addHook({ name: 'mongodb-core', versions: ['~3.1.10'], file: 'lib/wireprotocol/3_2_support.js' }, WireProtocol => {
  shimmer.wrap(WireProtocol.prototype, 'command', command => wrapUnifiedCommand(command, 'command'))
  return WireProtocol
})

addHook({ name: 'mongodb-core', versions: ['~3.1.10'], file: 'lib/wireprotocol/2_6_support.js' }, WireProtocol => {
  shimmer.wrap(WireProtocol.prototype, 'command', command => wrapUnifiedCommand(command, 'command'))
  return WireProtocol
})

addHook({ name: 'mongodb', versions: ['>=3.5.4'], file: 'lib/utils.js' }, util => {
  shimmer.wrap(util, 'maybePromise', maybePromise => function (parent, callback, fn) {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const callbackIndex = arguments.length - 2

    callback = arguments[callbackIndex]

    if (typeof callback === 'function') {
      arguments[callbackIndex] = asyncResource.bind(callback)
    }

    return maybePromise.apply(this, arguments)
  })
  return util
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
  const wrapped = function (server, ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    return instrument(operation, command, this, arguments, server, ns, ops, { name })
  }
  return shimmer.wrap(command, wrapped)
}

function wrapConnectionCommand (command, operation, name) {
  const wrapped = function (ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    const hostParts = typeof this.address === 'string' ? this.address.split(':') : ''
    const options = hostParts.length === 2
      ? { host: hostParts[0], port: hostParts[1] }
      : {} // no port means the address is a random UUID so no host either
    const topology = { s: { options } }

    ns = `${ns.db}.${ns.collection}`
    return instrument(operation, command, this, arguments, topology, ns, ops, { name })
  }
  return shimmer.wrap(command, wrapped)
}

function wrapQuery (query, operation, name) {
  const wrapped = function () {
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }
    const pool = this.server.s.pool
    const ns = this.ns
    const ops = this.cmd
    return instrument(operation, query, this, arguments, pool, ns, ops)
  }

  return shimmer.wrap(query, wrapped)
}

function wrapCursor (cursor, operation, name) {
  const wrapped = function () {
    if (!startCh.hasSubscribers) {
      return cursor.apply(this, arguments)
    }
    const pool = this.server.s.pool
    const ns = this.ns
    return instrument(operation, cursor, this, arguments, pool, ns, {}, { name })
  }
  return shimmer.wrap(cursor, wrapped)
}

function wrapCommand (command, operation, name) {
  const wrapped = function (ns, ops) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }
    return instrument(operation, command, this, arguments, this, ns, ops, { name })
  }
  return shimmer.wrap(command, wrapped)
}

function instrument (operation, command, ctx, args, server, ns, ops, options = {}) {
  const name = options.name || (ops && Object.keys(ops)[0])
  const index = args.length - 1
  let callback = args[index]

  if (typeof callback !== 'function') return command.apply(ctx, args)

  const serverInfo = server && server.s && server.s.options
  const callbackResource = new AsyncResource('bound-anonymous-fn')
  const asyncResource = new AsyncResource('bound-anonymous-fn')

  callback = callbackResource.bind(callback)

  return asyncResource.runInAsyncScope(() => {
    startCh.publish({ ns, ops, options: serverInfo, name })

    args[index] = asyncResource.bind(function (err, res) {
      if (err) {
        errorCh.publish(err)
      }

      finishCh.publish()

      if (callback) {
        return callback.apply(this, arguments)
      }
    })

    try {
      return command.apply(ctx, args)
    } catch (err) {
      errorCh.publish(err)

      throw err
    }
  })
}
