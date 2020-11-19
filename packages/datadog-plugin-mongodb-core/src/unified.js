'use strict'

const { instrument } = require('./util')

function createWrapCommand (tracer, config, name) {
  return function wrapCommand (command) {
    return function commandWithTrace (server, ns, ops) {
      return instrument(command, this, arguments, server, ns, ops, tracer, config, { name })
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

function patchClass (WireProtocol, tracer, config) {
  this.wrap(WireProtocol.prototype, 'command', createWrapCommand(tracer, config))
}

function unpatchClass (WireProtocol) {
  this.unwrap(WireProtocol.prototype, 'command')
}

module.exports = [
  {
    name: 'mongodb',
    versions: ['>=3.3'],
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
