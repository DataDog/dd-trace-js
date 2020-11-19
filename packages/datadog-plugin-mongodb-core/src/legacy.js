'use strict'

const { instrument } = require('./util')

function createWrapCommand (tracer, config, name) {
  return function wrapCommand (command) {
    return function commandWithTrace (ns, ops) {
      return instrument(command, this, arguments, this, ns, ops, tracer, config, { name })
    }
  }
}

function createWrapQuery (tracer, config) {
  return function wrapQuery (query) {
    return function queryWithTrace () {
      const pool = this.server.s.pool
      const ns = this.ns
      const ops = this.cmd

      return instrument(query, this, arguments, pool, ns, ops, tracer, config)
    }
  }
}

function createWrapCursor (tracer, config, name) {
  return function wrapCursor (cursor) {
    return function cursorWithTrace () {
      const pool = this.server.s.pool
      const ns = this.ns

      return instrument(cursor, this, arguments, pool, ns, {}, tracer, config, { name })
    }
  }
}

module.exports = [
  {
    name: 'mongodb-core',
    versions: ['2 - 3.1.9'],
    patch ({ Cursor, Server }, tracer, config) {
      this.wrap(Server.prototype, 'command', createWrapCommand(tracer, config))
      this.wrap(Server.prototype, 'insert', createWrapCommand(tracer, config, 'insert'))
      this.wrap(Server.prototype, 'update', createWrapCommand(tracer, config, 'update'))
      this.wrap(Server.prototype, 'remove', createWrapCommand(tracer, config, 'remove'))
      this.wrap(Cursor.prototype, '_getmore', createWrapCursor(tracer, config, 'getMore'))
      this.wrap(Cursor.prototype, '_find', createWrapQuery(tracer, config))
      this.wrap(Cursor.prototype, 'kill', createWrapCursor(tracer, config, 'killCursors'))
    },
    unpatch ({ Cursor, Server }) {
      this.unwrap(Server.prototype, 'command')
      this.unwrap(Server.prototype, 'insert')
      this.unwrap(Server.prototype, 'update')
      this.unwrap(Server.prototype, 'remove')
      this.unwrap(Cursor.prototype, '_getmore')
      this.unwrap(Cursor.prototype, '_find')
      this.unwrap(Cursor.prototype, 'kill')
    }
  }
]
