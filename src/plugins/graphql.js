'use strict'

const shimmer = require('shimmer')
const platform = require('../platform')

function createWrapGraphql (tracer, config, defaultFieldResolver) {
  return function wrapGraphql (graphql) {
    return function graphqlWithTrace () {
      const source = arguments[1] || arguments[0].source
      const contextValue = arguments[3] || arguments[0].contextValue || {}

      if (arguments.length === 1) {
        arguments[0].contextValue = contextValue
      } else {
        arguments[3] = contextValue
        arguments.length = Math.max(arguments.length, 4)
      }

      Object.defineProperties(contextValue, {
        _datadog_operation: { value: {} },
        _datadog_fields: { value: {} },
        _datadog_source: { value: source }
      })

      return graphql.apply(this, arguments)
    }
  }
}

function createWrapExecute (tracer, config, defaultFieldResolver) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const schema = arguments[0]
      const contextValue = arguments[3]
      const fieldResolver = arguments[6] || defaultFieldResolver

      arguments[6] = wrapResolve(fieldResolver, tracer, config)
      arguments[3] = contextValue

      if (!schema._datadog_patched) {
        wrapFields(schema._queryType._fields, tracer, config, [])
        schema._datadog_patched = true
      }

      return call(execute, this, arguments, defer(tracer), () => finishOperation(contextValue))
    }
  }
}

function wrapFields (fields, tracer, config) {
  Object.keys(fields).forEach(key => {
    const field = fields[key]

    if (typeof field.resolve === 'function') {
      field.resolve = wrapResolve(field.resolve, tracer, config)
    }

    if (field.type && field.type._fields) {
      wrapFields(field.type._fields, tracer, config)
    }
  })
}

function wrapResolve (resolve, tracer, config) {
  return function resolveWithTrace (source, args, contextValue, info) {
    const path = getPath(info.path)
    const fieldParent = getFieldParent(tracer, config, contextValue, info, path)
    const childOf = createSpan('graphql.field', tracer, config, fieldParent, path)
    const deferred = defer(tracer)

    let result

    contextValue._datadog_fields[path] = {
      span: childOf,
      parent: fieldParent
    }

    tracer.trace('graphql.resolve', { childOf }, span => {
      addTags(span, tracer, config, path)

      result = call(resolve, this, arguments, deferred, err => finish(span, contextValue, path, err))
    })

    return result
  }
}

function call (fn, thisContext, args, deferred, callback) {
  try {
    let result = fn.apply(thisContext, args)

    if (result && typeof result.then === 'function') {
      result = result
        .then(value => {
          callback(null, value)
          deferred.resolve(value)
          return deferred.promise
        })
        .catch(err => {
          callback(err)
          deferred.reject(err)
          return deferred.promise
        })
    } else {
      callback(null, result)
    }

    return result
  } catch (e) {
    callback(e)
    throw e
  }
}

function defer (tracer) {
  const deferred = {}

  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = tracer.bind(resolve)
    deferred.reject = tracer.bind(reject)
  })

  return deferred
}

function getFieldParent (tracer, config, contextValue, info, path) {
  if (!contextValue._datadog_operation.span) {
    contextValue._datadog_operation.span = createOperationSpan(tracer, config, contextValue, info)
  }

  if (path.length === 1) {
    return contextValue._datadog_operation.span
  }

  return contextValue._datadog_fields[path.slice(0, -1).join('.')].span
}

function createOperationSpan (tracer, config, contextValue, info) {
  const type = info.operation.operation
  const name = info.operation.name && info.operation.name.value

  let span

  tracer.trace(`graphql.${info.operation.operation}`, parent => {
    span = parent
    span.addTags({
      'service.name': getService(tracer, config),
      'resource.name': [type, name].filter(val => val).join(' '),
      'span.type': 'custom',
      'graphql.source': contextValue._datadog_source
    })
  })

  return span
}

function createSpan (name, tracer, config, childOf, path) {
  let span

  tracer.trace(name, { childOf }, parent => {
    span = parent
    addTags(span, tracer, config, path)
  })

  return span
}

function addTags (span, tracer, config, path) {
  span.addTags({
    'service.name': getService(tracer, config),
    'resource.name': path.join('.'),
    'span.type': 'custom'
  })
}

function finish (span, contextValue, path, error) {
  addError(span, error)

  span.finish()

  for (let i = path.length - 2; i >= 0; i--) {
    contextValue._datadog_fields[path[i]].finishTime = platform.now()
  }
}

function finishOperation (contextValue) {
  for (const key in contextValue._datadog_fields) {
    contextValue._datadog_fields[key].span.finish(contextValue._datadog_fields[key].finishTime)
  }

  contextValue._datadog_operation.span.finish()
}

function getService (tracer, config) {
  return config.service || `${tracer._service}-graphql`
}

function getPath (path) {
  if (path.prev) {
    return getPath(path.prev).concat(path.key)
  } else {
    return [path.key]
  }
}

function addError (span, error) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  return error
}

module.exports = [
  {
    name: 'graphql',
    file: 'graphql.js',
    versions: ['0.13.x'],
    patch (graphql, tracer, config) {
      shimmer.wrap(graphql, 'graphql', createWrapGraphql(tracer, config))
    },
    unpatch (graphql) {
      shimmer.unwrap(graphql, 'graphql')
    }
  },
  {
    name: 'graphql',
    file: 'execution/execute.js',
    versions: ['0.13.x'],
    patch (execute, tracer, config) {
      shimmer.wrap(execute, 'execute', createWrapExecute(tracer, config, execute.defaultFieldResolver))
    },
    unpatch (execute) {
      shimmer.unwrap(execute, 'execute')
    }
  }
]
