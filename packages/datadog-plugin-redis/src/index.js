'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

class RedisPlugin extends Plugin {
  static get name () {
    return 'redis'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.name}:command:start`, (
      { db, command, args, connectionOptions, connectionName }
    ) => {
      if (!this.config.filter(command)) {
        return this.skip()
      }

      this.startSpan('redis.command', {
        service: getService(this.tracer, this.config, connectionName),
        resource: command,
        type: 'redis',
        kind: 'client',
        meta: {
          'db.type': 'redis',
          'db.name': db || '0',
          'redis.raw_command': formatCommand(command, args),
          'out.host': connectionOptions.host,
          'out.port': String(connectionOptions.port || '')
        }
      })
    })

    this.addSub(`apm:${this.constructor.name}:command:end`, () => {
      this.exit()
    })

    this.addSub(`apm:${this.constructor.name}:command:error`, err => {
      this.addError(err)
    })

    this.addSub(`apm:${this.constructor.name}:command:async-end`, () => {
      this.finishSpan()
    })
  }

  configure (config) {
    super.configure(normalizeConfig(config))
  }
}

function getService (tracer, config, connectionName) {
  if (config.splitByInstance && connectionName) {
    return config.service
      ? `${config.service}-${connectionName}`
      : connectionName
  }

  return config.service || `${tracer.config.service}-redis`
}

function formatCommand (command, args) {
  command = command.toUpperCase()

  if (!args || command === 'AUTH') return command

  for (let i = 0, l = args.length; i < l; i++) {
    if (typeof args[i] === 'function') continue

    command = `${command} ${formatArg(args[i])}`

    if (command.length > 1000) return trim(command, 1000)
  }

  return command
}

function formatArg (arg) {
  switch (typeof arg) {
    case 'string':
    case 'number':
      return trim(String(arg), 100)
    default:
      return '?'
  }
}

function trim (str, maxlen) {
  if (str.length > maxlen) {
    str = str.substr(0, maxlen - 3) + '...'
  }

  return str
}

function normalizeConfig (config) {
  const filter = urlFilter.getFilter(config)

  return Object.assign({}, config, {
    filter
  })
}

module.exports = RedisPlugin
