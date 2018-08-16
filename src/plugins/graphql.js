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
        wrapFields(schema._queryType, tracer, config, responsePathAsArray)
        wrapFields(schema._mutationType, tracer, config, responsePathAsArray)

        schema._datadog_patched = true
      }

      if (!contextValue._datadog_operation) {
        Object.defineProperties(contextValue, {
          _datadog_operation: {
            value: {
              span: createOperationSpan(tracer, config, operation, document._datadog_source)
            }
          },
          _datadog_fields: { value: {} }
        })
      }

      return call(execute, this, [args], err => finishOperation(contextValue, err))
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

function wrapFields (type, tracer, config, responsePathAsArray) {
  if (!type || type._datadog_patched) {
    return
  }

  type._datadog_patched = true

  Object.keys(type._fields).forEach(key => {
    const field = type._fields[key]

    if (typeof field.resolve === 'function' && !field.resolve._datadog_patched) {
      field.resolve = wrapResolve(field.resolve, tracer, config, responsePathAsArray)
    }

    if (field.type) {
      if (field.type._fields) {
        wrapFields(field.type, tracer, config, responsePathAsArray)
      } else if (field.type.ofType && field.type.ofType._fields) {
        wrapFields(field.type.ofType, tracer, config, responsePathAsArray)
      }
    }
  })
}

function wrapResolve (resolve, tracer, config, responsePathAsArray) {
  function resolveWithTrace (source, args, contextValue, info) {
    if (!contextValue || !contextValue._datadog_fields) {
      return resolve.apply(arguments)
    }

    const path = responsePathAsArray(info.path)
    const fieldParent = getFieldParent(contextValue, path)

    const childOf = createSpan('graphql.field', tracer, config, fieldParent, path)

    contextValue._datadog_fields[path.join('.')] = {
      span: childOf,
      parent: fieldParent
    }

    const span = tracer.startSpan('graphql.resolve', { childOf })
    const scope = tracer.scopeManager().activate(span)

    addTags(span, tracer, config, path)

    return call(resolve, this, arguments, err => finish(scope, contextValue, path, err))
  }

  resolveWithTrace._datadog_patched = true

  return resolveWithTrace
}

function wrapFieldResolver (fieldResolver, tracer, config, responsePathAsArray) {
  return function fieldResolverWithTrace (source, args, contextValue, info) {
    if (source && typeof source[info.fieldName] === 'function') {
      return wrapResolve(fieldResolver, tracer, config, responsePathAsArray).apply(this, arguments)
    }

    return fieldResolver.apply(this, arguments)
  }
}

function call (fn, thisContext, args, callback) {
  try {
    let result = fn.apply(thisContext, args)

    if (result && typeof result.then === 'function') {
      result = result
        .then(value => {
          callback(null, value)
          return value
        })
        .catch(err => {
          callback(err)
          return Promise.reject(err)
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

  const parentScope = tracer.scopeManager().active()
  const span = tracer.startSpan(`graphql.${operation.operation}`, {
    childOf: parentScope && parentScope.span(),
    tags: {
      'service.name': getService(tracer, config),
      'resource.name': [type, name].filter(val => val).join(' '),
      'graphql.document': source
    }
  })

  return span
}

function createSpan (name, tracer, config, childOf, path) {
  const span = tracer.startSpan(name, { childOf })

  addTags(span, tracer, config, path)

  return span
}

function addTags (span, tracer, config, path) {
  span.addTags({
    'service.name': getService(tracer, config),
    'resource.name': path.join('.')
  })
}

function finish (scope, contextValue, path, error) {
  const span = scope.span()

  addError(span, error)

  span.finish()
  scope.close()

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

  const types = ['query', 'mutation']
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
