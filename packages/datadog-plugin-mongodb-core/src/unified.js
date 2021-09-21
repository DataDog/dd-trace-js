'use strict'

const { instrument } = require('./util')

function createWrapConnectionCommand (tracer, config, name) {
  return function wrapCommand (command) {
    return function commandWithTrace (ns, ops) {
      const hostParts = typeof this.address === 'string' ? this.address.split(':') : ''
      const options = hostParts.length === 2
        ? { host: hostParts[0], port: hostParts[1] }
        : {} // no port means the address is a random UUID so no host either
      const topology = { s: { options } }

      ns = `${ns.db}.${ns.collection}`

      return instrument(command, this, arguments, topology, ns, ops, tracer, config, { name })
    }
  }
}

function createWrapCommand (tracer, config, name) {
  return function wrapCommand (command) {
    return function commandWithTrace (server, ns, ops) {
      return instrument(command, this, arguments, server, ns, ops, tracer, config, { name })
    }
  }
}

function createWrapMaybePromise (tracer, config) {
  return function wrapMaybePromise (maybePromise) {
    return function maybePromiseWithTrace (parent, callback, fn) {
      const callbackIndex = arguments.length - 2

      callback = arguments[callbackIndex]

      if (typeof callback === 'function') {
        arguments[callbackIndex] = tracer.scope().bind(callback)
      }

      return maybePromise.apply(this, arguments)
    }
  }
}

function patch (wp, tracer, config) {
  this.wrap(wp, 'command', createWrapCommand(tracer, config))
  this.wrap(wp, 'insert', createWrapCommand(tracer, config, 'insert'))
  this.wrap(wp, 'update', createWrapCommand(tracer, config, 'update'))
  this.wrap(wp, 'remove', createWrapCommand(tracer, config, 'remove'))
  this.wrap(wp, 'query', createWrapCommand(tracer, config))
  this.wrap(wp, 'getMore', createWrapCommand(tracer, config, 'getMore'))
  this.wrap(wp, 'killCursors', createWrapCommand(tracer, config, 'killCursors'))
}

function unpatch (wp) {
  this.unwrap(wp, 'command')
  this.unwrap(wp, 'insert')
  this.unwrap(wp, 'update')
  this.unwrap(wp, 'remove')
  this.unwrap(wp, 'query')
  this.unwrap(wp, 'getMore')
  this.unwrap(wp, 'killCursors')
}

function patchConnection ({ Connection }, tracer, config) {
  const proto = Connection.prototype

  this.wrap(proto, 'command', createWrapConnectionCommand(tracer, config))
  this.wrap(proto, 'query', createWrapConnectionCommand(tracer, config))
  this.wrap(proto, 'getMore', createWrapConnectionCommand(tracer, config, 'getMore'))
  this.wrap(proto, 'killCursors', createWrapConnectionCommand(tracer, config, 'killCursors'))
}

function unpatchConnection ({ Connection }) {
  const proto = Connection.prototype

  this.unwrap(proto, 'command')
  this.unwrap(proto, 'query')
  this.unwrap(proto, 'getMore')
  this.unwrap(proto, 'killCursors')
}

function patchClass (WireProtocol, tracer, config) {
  this.wrap(WireProtocol.prototype, 'command', createWrapCommand(tracer, config))
}

function unpatchClass (WireProtocol) {
  this.unwrap(WireProtocol.prototype, 'command')
}

module.exports = [
  {
    name: 'mongodb',
    versions: ['>=4'],
    file: 'lib/cmap/connection.js',
    patch: patchConnection,
    unpatch: unpatchConnection
  },
  {
    name: 'mongodb',
    versions: ['>=3.5.4'],
    file: 'lib/utils.js',
    patch (util, tracer, config) {
      this.wrap(util, 'maybePromise', createWrapMaybePromise(tracer, config))
    },
    unpatch (util) {
      this.unwrap(util, 'maybePromise')
    }
  },
  {
    name: 'mongodb',
    versions: ['>=3.3 <4'],
    file: 'lib/core/wireprotocol/index.js',
    patch,
    unpatch
  },
  {
    name: 'mongodb-core',
    versions: ['>=3.2'],
    file: 'lib/wireprotocol/index.js',
    patch,
    unpatch
  },
  {
    name: 'mongodb-core',
    versions: ['~3.1.10'],
    file: 'lib/wireprotocol/3_2_support.js',
    patch: patchClass,
    unpatch: unpatchClass
  },
  {
    name: 'mongodb-core',
    versions: ['~3.1.10'],
    file: 'lib/wireprotocol/2_6_support.js',
    patch: patchClass,
    unpatch: unpatchClass
  }
]
