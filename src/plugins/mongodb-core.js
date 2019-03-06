'use strict'

const Buffer = require('safe-buffer').Buffer
const analyticsSampler = require('../analytics_sampler')

function createWrapOperation (tracer, config, operationName) {
  return function wrapOperation (operation) {
    return function operationWithTrace (ns, ops, options, callback) {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('mongodb.query', { childOf })

      addTags(span, tracer, config, ns, ops, this, operationName)

      analyticsSampler.sample(span, config.analytics)

      if (typeof options === 'function') {
        return scope
          .bind(operation, span)
          .call(this, ns, ops, wrapCallback(tracer, span, options))
      } else {
        return scope
          .bind(operation, span)
          .call(this, ns, ops, options, wrapCallback(tracer, span, callback))
      }
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

module.exports = [
  {
    name: 'mongodb-core',
    versions: ['>=2'],
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
