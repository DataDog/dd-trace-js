'use strict'

const platform = require('../platform')
const log = require('../log')

function createWrapExecute (tracer, config, defaultFieldResolver, responsePathAsArray) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const args = normalizeArgs(arguments)
      const schema = args.schema
      const document = args.document
      const contextValue = args.contextValue || {}
      const fieldResolver = args.fieldResolver || defaultFieldResolver
      const variableValues = args.variableValues
      const operation = getOperation(document)

      if (!schema || !operation || typeof fieldResolver !== 'function') {
        return execute.apply(this, arguments)
      }

      args.contextValue = contextValue

      if (config.depth !== 0) {
        args.fieldResolver = wrapFieldResolver(fieldResolver, tracer, config, responsePathAsArray)

        if (!schema._datadog_patched) {
          wrapFields(schema._queryType, tracer, config, responsePathAsArray)
          wrapFields(schema._mutationType, tracer, config, responsePathAsArray)

          schema._datadog_patched = true
        }
      }

      if (!contextValue._datadog_spans) {
        const parseTime = document._datadog_parse_time
        const validateTime = document._datadog_validate_time

        const operationSpan = createOperationSpan(
          tracer,
          config,
          operation,
          document._datadog_source,
          variableValues,
          (parseTime && parseTime.start) || (validateTime && validateTime.start)
        )

        if (parseTime) {
          const span = createSpan(tracer, config, 'parse', operationSpan, parseTime.start)
          span.finish(parseTime.end)
        }
        if (validateTime) {
          const span = createSpan(tracer, config, 'validate', operationSpan, validateTime.start)
          span.finish(validateTime.end)
        }

        const executeSpan = createSpan(tracer, config, 'execute', operationSpan)

        Object.defineProperties(contextValue, {
          _datadog_spans: {
            value: { executeSpan, operationSpan }
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
      const start = platform.now()
      const document = parse.apply(this, arguments)
      const end = platform.now()

      Object.defineProperties(document, {
        _datadog_source: {
          value: source.body || source
        },
        _datadog_parse_time: {
          value: { start, end }
        }
      })

      return document
    }
  }
}

function createWrapValidate (tracer, config) {
  return function wrapValidate (validate) {
    return function validateWithTrace (schema, document, rules, typeInfo) {
      const start = platform.now()
      const errors = validate(schema, document, rules, typeInfo)
      const end = platform.now()

      Object.defineProperties(document, {
        _datadog_validate_time: {
          value: { start, end }
        }
      })

      return errors
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
    const depth = path.filter(item => typeof item === 'string').length

    if (config.depth > 0 && config.depth < depth) {
      return call(resolve, this, arguments, err => updateFinishTime(scope, contextValue, path, err))
    }

    const fieldParent = getFieldParent(contextValue, path)

    const childOf = createPathSpan(tracer, config, 'field', fieldParent, path)

    contextValue._datadog_fields[path.join('.')] = {
      span: childOf,
      parent: fieldParent
    }

    const span = createPathSpan(tracer, config, 'resolve', childOf, path)
    const scope = tracer.scopeManager().activate(span)

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

  return contextValue._datadog_spans.executeSpan
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

function createOperationSpan (tracer, config, operation, source, variableValues, startTime) {
  const type = operation.operation
  const name = operation.name && operation.name.value
  const parentScope = tracer.scopeManager().active()
  const tags = {
    'service.name': getService(tracer, config),
    'resource.name': [type, name].filter(val => val).join(' '),
    'graphql.document': source
  }
  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    for (const param in variables) {
      tags[`graphql.variables.${param}`] = variables[param]
    }
  }
  const span = tracer.startSpan(`graphql.${operation.operation}`, {
    tags,
    startTime,
    childOf: parentScope && parentScope.span()
  })

  return span
}

function createSpan (tracer, config, name, childOf, startTime) {
  const span = tracer.startSpan(`graphql.${name}`, {
    childOf,
    startTime,
    tags: {
      'service.name': getService(tracer, config)
    }
  })
  return span
}

function createPathSpan (tracer, config, name, childOf, path) {
  const span = createSpan(tracer, config, name, childOf)

  span.addTags({
    'resource.name': path.join('.')
  })

  return span
}

function finish (scope, contextValue, path, error) {
  const span = scope.span()

  addError(span, error)

  span.finish()
  scope.close()

  updateFinishTime(contextValue, path)
}

function updateFinishTime (contextValue, path) {
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

  addError(contextValue._datadog_spans.executeSpan, error)

  contextValue._datadog_spans.executeSpan.finish()
  contextValue._datadog_spans.operationSpan.finish()
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

  const types = ['query', 'mutation', 'subscription']
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

function validateConfig (config) {
  return Object.assign({}, config, {
    depth: getDepth(config),
    variables: getVariablesFilter(config)
  })
}

function getDepth (config) {
  if (typeof config.depth === 'number') {
    return config.depth
  } else if (config.hasOwnProperty('depth')) {
    log.error('Expected `depth` to be a integer.')
  }
  return -1
}

function getVariablesFilter (config) {
  if (typeof config.variables === 'function') {
    return config.variables
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be a function.')
  }
  return null
}

module.exports = [
  {
    name: 'graphql',
    file: 'execution/execute.js',
    versions: ['0.13.x'],
    patch (execute, tracer, config) {
      this.wrap(execute, 'execute', createWrapExecute(
        tracer,
        validateConfig(config),
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
      this.wrap(parser, 'parse', createWrapParse(tracer, validateConfig(config)))
    },
    unpatch (parser) {
      this.unwrap(parser, 'parse')
    }
  },
  {
    name: 'graphql',
    file: 'validation/validate.js',
    versions: ['0.13.x'],
    patch (validate, tracer, config) {
      this.wrap(validate, 'validate', createWrapValidate(tracer, validateConfig(config)))
    },
    unpatch (validate) {
      this.unwrap(validate, 'validate')
    }
  }
]
