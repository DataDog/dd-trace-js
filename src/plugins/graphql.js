'use strict'

const shimmer = require('shimmer')
const platform = require('../platform')

function createWrapExecute (tracer, config, defaultFieldResolver) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const args = normalizeArgs(arguments)
      const schema = args.schema
      const document = args.document
      const contextValue = args.contextValue || {}
      const fieldResolver = args.fieldResolver || defaultFieldResolver

      if (!schema || !document || typeof fieldResolver !== 'function') {
        return execute.apply(this, arguments)
      }

      args.fieldResolver = wrapResolve(fieldResolver, tracer, config)
      args.contextValue = contextValue

      Object.defineProperties(contextValue, {
        _datadog_operation: { value: {} },
        _datadog_fields: { value: {} },
        _datadog_source: { value: document._datadog_source }
      })

      if (!schema._datadog_patched) {
        wrapFields(schema._queryType._fields, tracer, config, [])
        schema._datadog_patched = true
      }

      return call(execute, this, [args], defer(tracer), () => finishOperation(contextValue))
    }
  }
}

function createWrapParse () {
  return function wrapParse (parse) {
    return function parseWithTrace (source) {
      const document = parse.apply(this, arguments)

      Object.defineProperties(document, {
        _datadog_source: { value: source }
      })

      return document
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

function normalizeArgs (args) {
  if (args.length === 1) {
    return args
  }

  return {
    schema: args[0],
    document: args[1],
    rootValue: args[2],
    contextValue: args[3],
    variableValues: args[4],
    operationName: args[5],
    fieldResolver: args[6]
  }
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
      'graphql.document': contextValue._datadog_source
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
    file: 'execution/execute.js',
    versions: ['0.13.x'],
    patch (execute, tracer, config) {
      shimmer.wrap(execute, 'execute', createWrapExecute(tracer, config, execute.defaultFieldResolver))
    },
    unpatch (execute) {
      shimmer.unwrap(execute, 'execute')
    }
  },
  {
    name: 'graphql',
    file: 'language/parser.js',
    versions: ['0.13.x'],
    patch (parser, tracer, config) {
      shimmer.wrap(parser, 'parse', createWrapParse(tracer, config))
    },
    unpatch (parser) {
      shimmer.unwrap(parser, 'parse')
    }
  }
]
