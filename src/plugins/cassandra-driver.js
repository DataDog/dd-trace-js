'use strict'

function createWrapInnerExecute (tracer, config) {
  return function wrapInnerExecute (_innerExecute) {
    return function _innerExecuteWithTrace (query, params, execOptions, callback) {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = start(tracer, config, this, query)

      callback = scope.bind(callback, childOf)

      return scope.bind(_innerExecute, span).call(this, query, params, execOptions, function (err) {
        finish(span, err)
        return callback.apply(this, arguments)
      })
    }
  }
}

function createWrapExecutionStart (tracer, config) {
  return function wrapExecutionStart (start) {
    return function startWithTrace (getHostCallback) {
      const span = tracer.scope().active()
      const execution = this

      return start.call(this, function () {
        addHost(span, execution._connection)
        return getHostCallback.apply(this, arguments)
      })
    }
  }
}

function createWrapSend (tracer, config) {
  return function wrapSend (send) {
    return function sendWithTrace (request, options, callback) {
      const span = tracer.scope().active()
      const handler = this

      return send.call(this, request, options, function () {
        addHost(span, handler.connection)
        return callback.apply(this, arguments)
      })
    }
  }
}

function createWrapBatch (tracer, config) {
  return function wrapBatch (batch) {
    return function batchWithTrace (queries, options, callback) {
      const query = combine(queries)
      const span = start(tracer, config, this, query)
      const scope = tracer.scope()

      callback = scope.bind(callback || options)

      return scope.bind(batch, span).call(this, queries, options, function (err) {
        finish(span, err)

        if (typeof callback === 'function') {
          return callback.apply(this, arguments)
        }
      })
    }
  }
}

function createWrapStream (tracer, config) {
  return function wrapStream (stream) {
    return function streamWithTrace (query, params, options, callback) {
      return tracer.scope().bind(stream.apply(this, arguments))
    }
  }
}

function start (tracer, config, client, query) {
  const scope = tracer.scope()
  const childOf = scope.active()
  const span = tracer.startSpan('cassandra.query', {
    childOf,
    tags: {
      'service.name': config.service || `${tracer._service}-cassandra`,
      'resource.name': trim(query, 5000),
      'span.type': 'cassandra',
      'span.kind': 'client',
      'db.type': 'cassandra',
      'cassandra.query': query
    }
  })

  if (client.keyspace) {
    addTag(span, 'cassandra.keyspace', client.keyspace)
  }

  return span
}

function finish (span, error) {
  addError(span, error)

  span.finish()

  return error
}

function addTag (span, key, value) {
  if (value) {
    span.setTag(key, value)
  }
}

function addHost (span, connection) {
  if (span && connection) {
    addTag(span, 'out.host', connection.address)
    addTag(span, 'out.port', connection.port)
  }
}

function addError (span, error) {
  if (error && error instanceof Error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  return error
}

function combine (queries) {
  return queries
    .map(query => (query.query || query).replace(/;?$/, ';'))
    .join(' ')
}

function trim (str, size) {
  if (str.length <= size) return str

  return `${str.substr(0, size - 3)}...`
}

module.exports = [
  {
    name: 'cassandra-driver',
    versions: ['>=3.0.0'],
    patch (cassandra, tracer, config) {
      this.wrap(cassandra.Client.prototype, '_innerExecute', createWrapInnerExecute(tracer, config))
      this.wrap(cassandra.Client.prototype, 'batch', createWrapBatch(tracer, config))
      this.wrap(cassandra.Client.prototype, 'stream', createWrapStream(tracer, config))
    },
    unpatch (cassandra) {
      this.unwrap(cassandra.Client.prototype, '_innerExecute')
      this.unwrap(cassandra.Client.prototype, 'batch')
      this.unwrap(cassandra.Client.prototype, 'stream')
    }
  },
  {
    name: 'cassandra-driver',
    versions: ['>=3.3.0'],
    file: 'lib/request-execution.js',
    patch (RequestExecution, tracer, config) {
      this.wrap(RequestExecution.prototype, 'start', createWrapExecutionStart(tracer, config))
    },
    unpatch (RequestExecution) {
      this.unwrap(RequestExecution.prototype, 'start')
    }
  },
  {
    name: 'cassandra-driver',
    versions: ['3 - 3.2'],
    file: 'lib/request-handler.js',
    patch (RequestHandler, tracer, config) {
      this.wrap(RequestHandler.prototype, 'send', createWrapSend(tracer, config))
    },
    unpatch (RequestHandler) {
      this.unwrap(RequestHandler.prototype, 'send')
    }
  }
]
