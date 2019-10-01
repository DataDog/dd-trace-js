'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapOperation (tracer, config, operationName) {
  return function wrapOperation (operation) {
    return function operationWithTrace (ns, ops) {
      const index = arguments.length - 1
      const callback = arguments[index]

      if (typeof callback !== 'function') return operation.apply(this, arguments)

      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('mongodb.query', { childOf })

      addTags(span, tracer, config, ns, ops, this, operationName)

      analyticsSampler.sample(span, config.analytics)

      arguments[index] = wrapCallback(tracer, span, callback)

      return scope.bind(operation, span).apply(this, arguments)
    }
  }
}

function createWrapNext (tracer, config) {
  return function wrapNext (next) {
    return function nextWithTrace (cb) {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('mongodb.query', { childOf })

      addTags(span, tracer, config, this.ns, this.cmd, this.topology)

      if (this.cursorState) {
        span.addTags({
          'mongodb.cursor.index': this.cursorState.cursorIndex
        })
      }

      scope.bind(next, span).call(this, wrapCallback(tracer, span, cb, this))
    }
  }
}

function addTags (span, tracer, config, ns, cmd, topology, operationName) {
  const query = getQuery(cmd)
  const resource = getResource(ns, cmd, query, operationName)

  span.addTags({
    'service.name': config.service || `${tracer._service}-mongodb`,
    'resource.name': resource,
    'span.type': 'mongodb',
    'db.name': ns
  })

  if (query) {
    span.setTag('mongodb.query', query)
  }

  addHost(span, topology)
}

function addHost (span, topology) {
  const options = topology && topology.s && topology.s.options

  if (options && options.host && options.port) {
    span.addTags({
      'out.host': topology.s.options.host,
      'out.port': topology.s.options.port
    })
  }
}

function wrapCallback (tracer, span, done, cursor) {
  return tracer.scope().bind((err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    if (cursor) {
      addHost(span, cursor.server)
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  })
}

function getQuery (cmd) {
  return cmd.query && JSON.stringify(sanitize(cmd.query))
}

function getResource (ns, cmd, query, operationName) {
  if (!operationName) {
    operationName = Object.keys(cmd)[0]
  }

  const parts = [operationName, ns]

  if (query) {
    parts.push(query)
  }

  return parts.join(' ')
}

function sanitize (input) {
  const output = {}

  if (!isObject(input) || Buffer.isBuffer(input) || isBSON(input)) return '?'

  for (const key in input) {
    if (typeof input[key] === 'function') continue

    output[key] = sanitize(input[key])
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

function isBSON (val) {
  return val && val._bsontype
}

function patch (core, tracer, config) {
  this.wrap(core.Server.prototype, 'command', createWrapOperation(tracer, config))
  this.wrap(core.Server.prototype, 'insert', createWrapOperation(tracer, config, 'insert'))
  this.wrap(core.Server.prototype, 'update', createWrapOperation(tracer, config, 'update'))
  this.wrap(core.Server.prototype, 'remove', createWrapOperation(tracer, config, 'remove'))

  if (core.Cursor.prototype.next) {
    this.wrap(core.Cursor.prototype, 'next', createWrapNext(tracer, config))
  } else if (core.Cursor.prototype._next) {
    this.wrap(core.Cursor.prototype, '_next', createWrapNext(tracer, config))
  }
}

function unpatch (core) {
  this.unwrap(core.Server.prototype, 'command')
  this.unwrap(core.Server.prototype, 'insert')
  this.unwrap(core.Server.prototype, 'update')
  this.unwrap(core.Server.prototype, 'remove')
  this.unwrap(core.Cursor.prototype, 'next')
  this.unwrap(core.Cursor.prototype, '_next')
}

module.exports = [
  {
    name: 'mongodb',
    versions: ['>=3.3'],
    file: 'lib/core/index.js',
    patch,
    unpatch
  },
  {
    name: 'mongodb-core',
    versions: ['>=2'],
    patch,
    unpatch
  }
]
