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
      const source = document._datadog_source
      const fieldResolver = args.fieldResolver || defaultFieldResolver
      const contextValue = args.contextValue = args.contextValue || {}
      const variableValues = args.variableValues
      const operation = getOperation(document)

      if (!schema || !operation || !source || typeof fieldResolver !== 'function') {
        return execute.apply(this, arguments)
      }

      args.fieldResolver = wrapFieldResolver(fieldResolver, tracer, config, responsePathAsArray)

      wrapFields(schema._queryType, tracer, config, responsePathAsArray)
      wrapFields(schema._mutationType, tracer, config, responsePathAsArray)

      const span = startExecutionSpan(tracer, config, operation, document, variableValues)

      if (!contextValue._datadog_fields) {
        Object.defineProperty(contextValue, '_datadog_source', { value: source })
        Object.defineProperty(contextValue, '_datadog_fields', { value: {} })
      }

      return call(execute, span, this, [args], (err, span) => {
        finishResolvers(contextValue)
        finish(err, span)
      })
    }
  }
}

function createWrapParse (tracer, config) {
  return function wrapParse (parse) {
    return function parseWithTrace (source) {
      const span = startSpan(tracer, config, 'parse')

      try {
        const document = parse.apply(this, arguments)
        const operation = getOperation(document)

        if (!operation) return document // skip schema parsing

        Object.defineProperties(document, {
          _datadog_source: {
            value: source.body || source
          }
        })

        addMethodTags(tracer, config, span, operation, document)

        finish(null, span)

        return document
      } catch (e) {
        finish(e, span)
        throw e
      }
    }
  }
}

function createWrapValidate (tracer, config) {
  return function wrapValidate (validate) {
    return function validateWithTrace (schema, document, rules, typeInfo) {
      const span = startSpan(tracer, config, 'validate')

      try {
        const errors = validate.apply(this, arguments)
        const operation = getOperation(document)

        addMethodTags(tracer, config, span, operation, document)

        finish(null, span)

        return errors
      } catch (e) {
        finish(e, span)
        throw e
      }
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
    const path = responsePathAsArray(info.path)
    const depth = path.filter(item => typeof item === 'string').length

    if (config.depth >= 0 && config.depth < depth) {
      const parent = getParentField(tracer, contextValue, path)

      return call(resolve, parent.span, this, arguments)
    }

    const field = assertField(tracer, config, contextValue, info, path)

    return call(resolve, field.span, this, arguments, err => updateField(field, err))
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

function call (fn, span, thisArg, args, callback) {
  const scope = span.tracer().scope()

  callback = callback || (() => {})

  try {
    const result = scope.activate(span, () => fn.apply(thisArg, args))

    if (result && typeof result.then === 'function') {
      result.then(
        () => callback(null, span),
        err => callback(err, span)
      )
    } else {
      callback(null, span)
    }

    return result
  } catch (e) {
    callback(e, span)
    throw e
  }
}

function getParentField (tracer, contextValue, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(tracer, contextValue, path.slice(0, i))

    if (field) {
      return field
    }
  }

  return {
    span: tracer.scope().active()
  }
}

function getField (tracer, contextValue, path) {
  const fields = contextValue._datadog_fields
  const executionId = getExecutionId(tracer)

  return fields[executionId] && fields[executionId][path.join('.')]
}

function getExecutionId (tracer) {
  const span = tracer.scope().active()
  return span ? span.context().toSpanId() : '0'
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

function startExecutionSpan (tracer, config, operation, document, variableValues) {
  const span = startSpan(tracer, config, 'execute')

  addMethodTags(tracer, config, span, operation, document)
  addVariableTags(tracer, config, span, variableValues)

  return span
}

function addMethodTags (tracer, config, span, operation, document) {
  const type = operation.operation
  const name = operation.name && operation.name.value
  const tags = {
    'resource.name': [type, name].filter(val => val).join(' '),
    'graphql.operation.type': type,
    'graphql.operation.name': name
  }

  if (document._datadog_source) {
    tags['graphql.document'] = document._datadog_source
  }

  span.addTags(tags)
}

function addVariableTags (tracer, config, span, variableValues) {
  const tags = {}

  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    for (const param in variables) {
      tags[`graphql.variables.${param}`] = variables[param]
    }
  }

  span.addTags(tags)
}

function startSpan (tracer, config, name, childOf) {
  childOf = childOf || tracer.scope().active()

  return tracer.startSpan(`graphql.${name}`, {
    childOf,
    tags: {
      'service.name': getService(tracer, config)
    }
  })
}

function startResolveSpan (tracer, config, childOf, path, info, contextValue) {
  const span = startSpan(tracer, config, 'resolve', childOf)
  const document = contextValue._datadog_source
  const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')

  span.addTags({
    'resource.name': `${info.fieldName}:${info.returnType}`,
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

function finish (error, span, finishTime) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  span.finish(finishTime)
}

function finishResolvers (contextValue) {
  const fields = contextValue._datadog_fields

  Object.keys(fields).forEach(id => {
    Object.keys(fields[id]).reverse().forEach(key => {
      const field = fields[id][key]

      finish(field.error, field.span, field.finishTime)
    })
  })
}

function updateField (field, error) {
  field.finishTime = platform.now()
  field.error = field.error || error
}

function withCollapse (responsePathAsArray) {
  return function () {
    return responsePathAsArray.apply(this, arguments)
      .map(segment => typeof segment === 'number' ? '*' : segment)
  }
}

function assertField (tracer, config, contextValue, info, path) {
  const pathString = path.join('.')
  const fields = contextValue._datadog_fields
  const executionId = getExecutionId(tracer)

  fields[executionId] = fields[executionId] || {}

  let field = fields[executionId][pathString]

  if (!field) {
    const parent = getParentField(tracer, contextValue, path)

    field = fields[executionId][pathString] = {
      parent,
      span: startResolveSpan(tracer, config, parent.span, path, info, contextValue),
      error: null
    }
  }

  return field
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
