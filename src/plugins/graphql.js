'use strict'

const pick = require('lodash.pick')
const platform = require('../platform')
const log = require('../log')

function createWrapExecute (tracer, config, defaultFieldResolver, responsePathAsArray) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const args = normalizeArgs(arguments)
      const schema = args.schema
      const document = args.document
      const fieldResolver = args.fieldResolver || defaultFieldResolver
      const variableValues = args.variableValues
      const operation = getOperation(document)

      if (!schema || !operation || typeof fieldResolver !== 'function') {
        return execute.apply(this, arguments)
      }

      args.fieldResolver = wrapFieldResolver(fieldResolver, tracer, config, responsePathAsArray)

      wrapFields(schema._queryType, tracer, config, responsePathAsArray)
      wrapFields(schema._mutationType, tracer, config, responsePathAsArray)

      addOperationSpan(tracer, config, operation, document, variableValues)
      addParseSpan(tracer, config, document, operation)
      addValidateSpan(tracer, config, document, operation)
      addExecuteSpan(tracer, config, operation)

      return call(execute, this, [args], err => finishOperation(operation, err))
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
  if (!type || !type._fields || type._datadog_patched) {
    return
  }

  type._datadog_patched = true

  Object.keys(type._fields).forEach(key => {
    const field = type._fields[key]

    if (typeof field.resolve === 'function') {
      field.resolve = wrapResolve(field.resolve, tracer, config, responsePathAsArray)
    }

    let unwrappedType = field.type

    while (unwrappedType.ofType) {
      unwrappedType = unwrappedType.ofType
    }

    wrapFields(unwrappedType, tracer, config, responsePathAsArray)
  })
}

function wrapResolve (resolve, tracer, config, responsePathAsArray) {
  if (resolve._datadog_patched) return resolve
  if (config.collapse) {
    responsePathAsArray = withCollapse(responsePathAsArray)
  }

  function resolveWithTrace (source, args, contextValue, info) {
    const operation = info.operation
    const path = responsePathAsArray(info.path)
    const depth = path.filter(item => typeof item === 'string').length

    if (config.depth >= 0 && config.depth < depth) {
      const fieldParent = getFieldParent(operation, path)

      return tracer.scope().activate(fieldParent, () => {
        return call(resolve, this, arguments, () => {
          updateFinishTime(operation, path)
        })
      })
    }

    const field = assertField(tracer, config, operation, path, info)

    return tracer.scope().activate(field.resolveSpan, () => {
      return call(resolve, this, arguments, err => finish(field.resolveSpan, operation, path, err))
    })
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
    const result = fn.apply(thisContext, args)

    if (result && typeof result.then === 'function') {
      result.then(value => callback(null, value), callback)
    } else {
      callback(null, result)
    }

    return result
  } catch (e) {
    callback(e)
    throw e
  }
}

function assertField (tracer, config, operation, path, info) {
  let field = getField(operation, path)

  if (!field) {
    field = operation._datadog_fields[path.join('.')] = {
      pending: 0,
      error: null
    }

    const fieldParent = getFieldParent(operation, path)
    const childOf = createPathSpan(tracer, config, 'field', fieldParent, path, info)
    const span = createPathSpan(tracer, config, 'resolve', childOf, path, info)

    field.parent = fieldParent
    field.span = childOf
    field.resolveSpan = span
  }

  field.pending++

  return field
}

function getFieldParent (operation, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(operation, path.slice(0, i))

    if (field) {
      return field.span
    }
  }

  return operation._datadog_execute_span
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

function addOperationSpan (tracer, config, operation, document, variableValues) {
  const parseTime = document._datadog_parse_time
  const validateTime = document._datadog_validate_time
  const startTime = (parseTime && parseTime.start) || (validateTime && validateTime.start)

  const operationSpan = createOperationSpan(
    tracer,
    config,
    operation,
    document,
    variableValues,
    startTime
  )

  Object.defineProperty(operation, '_datadog_source', { value: document._datadog_source })
  Object.defineProperty(operation, '_datadog_span', { value: operationSpan })
  Object.defineProperty(operation, '_datadog_fields', { value: {} })
}

function addExecuteSpan (tracer, config, operation) {
  const span = createSpan(tracer, config, 'execute', operation._datadog_span)

  Object.defineProperty(operation, '_datadog_execute_span', { value: span })
}

function addParseSpan (tracer, config, document, operation) {
  const parseTime = document._datadog_parse_time

  if (parseTime) {
    const span = createSpan(tracer, config, 'parse', operation._datadog_span, parseTime.start)
    span.finish(parseTime.end)
  }
}

function addValidateSpan (tracer, config, document, operation) {
  const validateTime = document._datadog_validate_time

  if (validateTime) {
    const span = createSpan(tracer, config, 'validate', operation._datadog_span, validateTime.start)
    span.finish(validateTime.end)
  }
}

function createOperationSpan (tracer, config, operation, document, variableValues, startTime) {
  const type = operation.operation
  const name = operation.name && operation.name.value
  const def = document.definitions.find(def => def.kind === 'OperationDefinition')
  const childOf = tracer.scope().active()
  const tags = {
    'service.name': getService(tracer, config),
    'resource.name': [type, name].filter(val => val).join(' ')
  }

  if (def) {
    tags['graphql.operation.type'] = def.operation

    if (def.name) {
      tags['graphql.operation.name'] = def.name.value
    }
  }

  if (document._datadog_source) {
    tags['graphql.document'] = document._datadog_source
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
    childOf
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

function createPathSpan (tracer, config, name, childOf, path, info) {
  const span = createSpan(tracer, config, name, childOf)
  const document = info.operation._datadog_source
  const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')

  span.addTags({
    'resource.name': path.join('.'),
    'graphql.field.name': info.fieldName,
    'graphql.field.path': path.join('.'),
    'graphql.field.type': info.returnType
  })

  if (fieldNode) {
    if (document) {
      span.setTag('graphql.field.source', document.substring(fieldNode.loc.start, fieldNode.loc.end))
    }

    if (config.variables) {
      const variables = config.variables(info.variableValues)

      fieldNode.arguments
        .filter(arg => arg.value && arg.value.kind === 'Variable')
        .filter(arg => arg.value.name && variables[arg.value.name.value])
        .map(arg => arg.value.name.value)
        .forEach(name => {
          span.setTag(`graphql.variables.${name}`, variables[name])
        })
    }
  }

  return span
}

function finish (span, operation, path, error) {
  const field = getField(operation, path)

  field.pending--

  if (field.error || field.pending > 0) return

  field.error = error

  addError(span, error)

  span.finish()

  updateFinishTime(operation, path)
}

function updateFinishTime (operation, path) {
  for (let i = path.length; i > 0; i--) {
    const field = getField(operation, path.slice(0, i))

    if (field) {
      field.finishTime = platform.now()
    }
  }
}

function finishOperation (operation, error) {
  Object.keys(operation._datadog_fields).reverse().forEach(key => {
    operation._datadog_fields[key].span.finish(operation._datadog_fields[key].finishTime)
  })

  addError(operation._datadog_execute_span, error)

  operation._datadog_execute_span.finish()
  operation._datadog_span.finish()
}

function withCollapse (responsePathAsArray) {
  return function () {
    return responsePathAsArray.apply(this, arguments)
      .map(segment => typeof segment === 'number' ? '*' : segment)
  }
}

function getField (operation, path) {
  return operation._datadog_fields[path.join('.')]
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
    variables: getVariablesFilter(config),
    collapse: config.collapse === undefined || !!config.collapse
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
  } else if (config.variables instanceof Array) {
    return variables => pick(variables, config.variables)
  } else if (config.hasOwnProperty('variables')) {
    log.error('Expected `variables` to be an array or function.')
  }
  return null
}

module.exports = [
  {
    name: 'graphql',
    file: 'execution/execute.js',
    versions: ['>=0.10'],
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
    versions: ['>=0.10'],
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
    versions: ['>=0.10'],
    patch (validate, tracer, config) {
      this.wrap(validate, 'validate', createWrapValidate(tracer, validateConfig(config)))
    },
    unpatch (validate) {
      this.unwrap(validate, 'validate')
    }
  }
]
