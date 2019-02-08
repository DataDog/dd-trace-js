'use strict'

const tx = require('./tx')

const redis = {
  // Start a span for a Redis command.
  instrument (tracer, config, db, command, args) {
    const childOf = tracer.scope().active()
    const span = tracer.startSpan('redis.command', {
      childOf,
      tags: {
        'span.kind': 'client',
        'resource.name': command,
        'span.type': 'redis',
        'db.type': 'redis',
        'db.name': db || '0',
        'out.host': '127.0.0.1',
        'out.port': String(6379),
        'redis.raw_command': formatCommand(command, args)
      }
    })

    span.setTag('service.name', config.service || `${span.context()._tags['service.name']}-redis`)

    return span
  }
}

function formatCommand (command, args) {
  command = command.toUpperCase()

  if (!args) return command

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

module.exports = Object.assign({}, tx, redis)
