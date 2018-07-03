'use strict'

const platform = require('../platform')

function createWrapExecute (tracer, config, defaultFieldResolver, responsePathAsArray) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const args = normalizeArgs(arguments)
      const schema = args.schema
      const document = args.document
      const contextValue = args.contextValue || {}
      const fieldResolver = args.fieldResolver || defaultFieldResolver
      const operation = getOperation(document)

      if (!schema || !operation || typeof fieldResolver !== 'function') {
        return execute.apply(this, arguments)
      }

      args.fieldResolver = wrapFieldResolver(fieldResolver, tracer, config, responsePathAsArray)
      args.contextValue = contextValue

      if (!schema._datadog_patched) {
        wrapFields(schema._queryType._fields, tracer, config, responsePathAsArray)
        schema._datadog_patched = true
      }

      Object.defineProperties(contextValue, {
        _datadog_operation: {
          value: {
            span: createOperationSpan(tracer, config, operation, document._datadog_source)
          }
        },
        _datadog_fields: { value: {} }
      })

      return call(execute, this, [args], defer(tracer), err => finishOperation(contextValue, err))
    }
  }
}

function createWrapParse () {
  return function wrapParse (parse) {
    return function parseWithTrace (source) {
      const document = parse.apply(this, arguments)

      Object.defineProperties(document, {
        _datadog_source: { value: source.body || source }
      })

      return document
    }
  }
}

function wrapFields (fields, tracer, config, responsePathAsArray) {
  Object.keys(fields).forEach(key => {
    const field = fields[key]

    if (typeof field.resolve === 'function') {
      field.resolve = wrapResolve(field.resolve, tracer, config, responsePathAsArray)
    }

    if (field.type && field.type._fields) {
      wrapFields(field.type._fields, tracer, config, responsePathAsArray)
    }
  })
}

function wrapResolve (resolve, tracer, config, responsePathAsArray) {
  return function resolveWithTrace (source, args, contextValue, info) {
    const path = responsePathAsArray(info.path)
    const fieldParent = getFieldParent(contextValue, path)
    const childOf = createSpan('graphql.field', tracer, config, fieldParent, path)
    const deferred = defer(tracer)

    let result

    contextValue._datadog_fields[path.join('.')] = {
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

function wrapFieldResolver (fieldResolver, tracer, config, responsePathAsArray) {
  return function fieldResolverWithTrace (source, args, contextValue, info) {
    if (source && typeof source[info.fieldName] === 'function') {
      return wrapResolve(fieldResolver, tracer, config, responsePathAsArray).apply(this, arguments)
    }

    return fieldResolver.apply(this, arguments)
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

function getFieldParent (contextValue, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(contextValue, path.slice(0, i))

    if (field) {
      return field.span
    }
  }

  return contextValue._datadog_operation.span
}

function normalizeArgs (args) {
  if (args.length === 1) {
    return args[0]
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

function createOperationSpan (tracer, config, operation, source) {
  const type = operation.operation
  const name = operation.name && operation.name.value

  let span

  tracer.trace(`graphql.${operation.operation}`, parent => {
    span = parent
    span.addTags({
      'service.name': getService(tracer, config),
      'resource.name': [type, name].filter(val => val).join(' '),
      'graphql.document': source
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
    'resource.name': path.join('.')
  })
}

function finish (span, contextValue, path, error) {
  addError(span, error)

  span.finish()

  for (let i = path.length; i > 0; i--) {
    const field = getField(contextValue, path.slice(0, i))

    if (field) {
      field.finishTime = platform.now()
    }
  }
}

function finishOperation (contextValue, error) {
  for (const key in contextValue._datadog_fields) {
    contextValue._datadog_fields[key].span.finish(contextValue._datadog_fields[key].finishTime)
  }

  addError(contextValue._datadog_operation.span, error)

  contextValue._datadog_operation.span.finish()
}

function getField (contextValue, path) {
  return contextValue._datadog_fields[path.join('.')]
}

function getService (tracer, config) {
  return config.service || `${tracer._service}-graphql`
}

function getOperation (document) {
  if (!document || !Array.isArray(document.definitions)) {
    return
  }

  const types = ['query', 'mutations']
  const definition = document.definitions.find(def => types.indexOf(def.operation) !== -1)

  return definition
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
      this.wrap(execute, 'execute', createWrapExecute(
        tracer,
        config,
        execute.defaultFieldResolver,
        execute.responsePathAsArray
      ))
    },
    unpatch (execute) {
      this.unwrap(execute, 'execute')
    }
  },
  {
    name: 'graphql',
    file: 'language/parser.js',
    versions: ['0.13.x'],
    patch (parser, tracer, config) {
      this.wrap(parser, 'parse', createWrapParse(tracer, config))
    },
    unpatch (parser) {
      this.unwrap(parser, 'parse')
    }
  }
]
