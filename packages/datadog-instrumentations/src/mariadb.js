'use strict'

const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')

function wrapConnectionAddCommand (addCommand) {
  return function (cmd) {
    if (!startCh.hasSubscribers) return addCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const name = cmd && cmd.constructor && cmd.constructor.name
    const isCommand = typeof cmd.start === 'function'
    const isQuery = isCommand && (name === 'Execute' || name === 'Query')

    // TODO: consider supporting all commands and not just queries
    cmd.start = isQuery
      ? wrapStart(cmd, cmd.start, asyncResource, this.opts)
      : bindStart(cmd, cmd.start, asyncResource)

    return asyncResource.bind(addCommand, this).apply(this, arguments)
  }
}

function bindStart (cmd, start, asyncResource) {
  return asyncResource.bind(function (packet, connection) {
    if (this.resolve) {
      this.resolve = asyncResource.bind(this.resolve)
    }

    if (this.reject) {
      this.reject = asyncResource.bind(this.reject)
    }

    return start.apply(this, arguments)
  }, cmd)
}

function wrapStart (cmd, start, asyncResource, config) {
  const callbackResource = new AsyncResource('bound-anonymous-fn')

  return asyncResource.bind(function (packet, connection) {
    if (!this.resolve || !this.reject) return start.apply(this, arguments)

    const sql = cmd.statement ? cmd.statement.query : cmd.sql

    startCh.publish({ sql, conf: config })

    const resolve = callbackResource.bind(this.resolve)
    const reject = callbackResource.bind(this.reject)

    this.resolve = asyncResource.bind(function () {
      finishCh.publish(undefined)
      resolve.apply(this, arguments)
    }, 'bound-anonymous-fn', this)

    this.reject = asyncResource.bind(function (error) {
      errorCh.publish(error)
      finishCh.publish(undefined)
      reject.apply(this, arguments)
    }, 'bound-anonymous-fn', this)

    this.start = start

    try {
      return start.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)
    }
  }, cmd)
}

addHook(
  {
    name: 'mariadb',
    file: 'lib/connection.js',
    versions: ['>=3']
  },
  (Connection) => {
    shimmer.wrap(Connection.prototype, 'addCommandEnable', wrapConnectionAddCommand)
    shimmer.wrap(Connection.prototype, 'addCommandEnablePipeline', wrapConnectionAddCommand)

    return Connection
  }
)
