'use strict'

const Buffer = require('safe-buffer').Buffer

function createWrapOperation (tracer, config, operationName) {
  return function wrapOperation (operation) {
    return function operationWithTrace (ns, ops, options, callback) {
      const parentScope = tracer.scopeManager().active()
      const span = tracer.startSpan('mongodb.query', {
        childOf: parentScope && parentScope.span()
      })

      addTags(span, tracer, config, ns, ops, this, operationName)

      if (typeof options === 'function') {
        return operation.call(this, ns, ops, wrapCallback(tracer, span, options))
      } else {
        return operation.call(this, ns, ops, options, wrapCallback(tracer, span, callback))
      }
    }
  }
}

function createWrapNext (tracer, config) {
  return function wrapNext (next) {
    return function nextWithTrace (cb) {
      const parentScope = tracer.scopeManager().active()
      const span = tracer.startSpan('mongodb.query', {
        childOf: parentScope && parentScope.span()
      })

      addTags(span, tracer, config, this.ns, this.cmd, this.topology)

      if (this.cursorState) {
        span.addTags({
          'mongodb.cursor.index': this.cursorState.cursorIndex
        })
      }

      next.call(this, wrapCallback(tracer, span, cb))
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

  if (topology.s && topology.s.options) {
    span.addTags({
      'out.host': topology.s.options.host,
      'out.port': topology.s.options.port
    })
  }
}

function wrapCallback (tracer, span, done) {
  return (err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  }
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

  if (!isObject(input) || Buffer.isBuffer(input)) return '?'
  if (isBSON(input)) return sanitize(input.toJSON())

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
  return val && val._bsontype && typeof val.toJSON === 'function'
}

module.exports = [
  {
    name: 'mongodb-core',
    versions: ['>=2 <=3'],
    patch (mongo, tracer, config) {
      this.wrap(mongo.Server.prototype, 'command', createWrapOperation(tracer, config))
      this.wrap(mongo.Server.prototype, 'insert', createWrapOperation(tracer, config, 'insert'))
      this.wrap(mongo.Server.prototype, 'update', createWrapOperation(tracer, config, 'update'))
      this.wrap(mongo.Server.prototype, 'remove', createWrapOperation(tracer, config, 'remove'))
      this.wrap(mongo.Cursor.prototype, 'next', createWrapNext(tracer, config))
    },
    unpatch (mongo) {
      this.unwrap(mongo.Server.prototype, 'command')
      this.unwrap(mongo.Server.prototype, 'insert')
      this.unwrap(mongo.Server.prototype, 'update')
      this.unwrap(mongo.Server.prototype, 'remove')
      this.unwrap(mongo.Cursor.prototype, 'next')
    }
  }
]
