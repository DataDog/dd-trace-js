'use strict'

const pick = require('lodash.pick')
const log = require('../../dd-trace/src/log')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

let tools

function createWrapExecute (tracer, config, defaultFieldResolver) {
  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const args = normalizeArgs(arguments, tracer, config, defaultFieldResolver)
      const schema = args.schema
      const document = args.document
      const source = document && document._datadog_source
      const contextValue = args.contextValue
      const operation = getOperation(document, args.operationName)

      if (contextValue._datadog_graphql) {
        return execute.apply(this, arguments)
      }

      if (schema) {
        wrapFields(schema._queryType, tracer, config)
        wrapFields(schema._mutationType, tracer, config)
      }

      const span = startExecutionSpan(tracer, config, operation, args)

      contextValue._datadog_graphql = { source, span, fields: {} }

      return call(execute, span, this, arguments, (err, res) => {
        finishResolvers(contextValue, config)

        setError(span, err || (res && res.errors && res.errors[0]))
        config.hooks.execute(span, args, res)
        finish(span)
      })
    }
  }
}

function createWrapParse (tracer, config) {
  return function wrapParse (parse) {
    return function parseWithTrace (source) {
      const span = startSpan(tracer, config, 'parse')

      analyticsSampler.sample(span, config.measured, true)

      let document
      try {
        document = parse.apply(this, arguments)
        const operation = getOperation(document)

        if (!operation) return document // skip schema parsing

        if (source) {
          document._datadog_source = source.body || source
        }

        addDocumentTags(span, document, config)

        return document
      } catch (e) {
        setError(span, e)
        throw e
      } finally {
        config.hooks.parse(span, source, document)
        finish(span)
      }
    }
  }
}

function createWrapValidate (tracer, config) {
  return function wrapValidate (validate) {
    return function validateWithTrace (schema, document, rules, typeInfo) {
      const span = startSpan(tracer, config, 'validate')

      analyticsSampler.sample(span, config.measured, true)

      // skip for schema stitching nested validation
      if (document && document.loc) {
        addDocumentTags(span, document, config)
      }

      let errors
      try {
        errors = validate.apply(this, arguments)

        setError(span, errors && errors[0])

        return errors
      } catch (e) {
        setError(span, e)
        throw e
      } finally {
        config.hooks.validate(span, document, errors)
        finish(span)
      }
    }
  }
}

function wrapFields (type, tracer, config) {
  if (!type || !type._fields || type._datadog_patched) {
    return
  }

  type._datadog_patched = true

  Object.keys(type._fields).forEach(key => {
    const field = type._fields[key]

    wrapFieldResolve(field, tracer, config)
    wrapFieldType(field, tracer, config)
  })
}

function wrapFieldResolve (field, tracer, config) {
  if (!field || !field.resolve) return

  field.resolve = wrapResolve(field.resolve, tracer, config)
}

function wrapFieldType (field, tracer, config) {
  if (!field || !field.type) return

  let unwrappedType = field.type

  while (unwrappedType.ofType) {
    unwrappedType = unwrappedType.ofType
  }

  wrapFields(unwrappedType, tracer, config)
}

function wrapResolve (resolve, tracer, config) {
  if (resolve._datadog_patched || typeof resolve !== 'function') return resolve

  const responsePathAsArray = config.collapse
    ? withCollapse(pathToArray)
    : pathToArray

  function resolveWithTrace (source, args, contextValue, info) {
    if (!contextValue._datadog_graphql) return resolve.apply(this, arguments)

    const path = responsePathAsArray(info && info.path)

    if (config.depth >= 0) {
      const depth = path.filter(item => typeof item === 'string').length

      if (config.depth < depth) {
        const parent = getParentField(tracer, contextValue, path)

        return call(resolve, parent.span, this, arguments)
      }
    }

    const field = assertField(tracer, config, contextValue, info, path)

    return call(resolve, field.span, this, arguments, err => updateField(field, err))
  }

  resolveWithTrace._datadog_patched = true

  return resolveWithTrace
}

function call (fn, span, thisArg, args, callback) {
  const scope = span.tracer().scope()

  callback = callback || (() => {})

  try {
    const result = scope.activate(span, () => fn.apply(thisArg, args))

    if (result && typeof result.then === 'function') {
      result.then(
        res => callback(null, res),
        err => callback(err)
      )
    } else {
      callback(null, result)
    }

    return result
  } catch (e) {
    callback(e)
    throw e
  }
}

function getParentField (tracer, contextValue, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(contextValue, path.slice(0, i))

    if (field) {
      return field
    }
  }

  return {
    span: contextValue._datadog_graphql.span
  }
}

function getField (contextValue, path) {
  return contextValue._datadog_graphql.fields[path.join('.')]
}

function normalizeArgs (args, tracer, config, defaultFieldResolver) {
  if (args.length !== 1) return normalizePositional(args, tracer, config, defaultFieldResolver)

  args[0].contextValue = args[0].contextValue || {}
  args[0].fieldResolver = wrapResolve(args[0].fieldResolver || defaultFieldResolver, tracer, config)

  return args[0]
}

function normalizePositional (args, tracer, config, defaultFieldResolver) {
  args[3] = args[3] || {} // contextValue
  args[6] = wrapResolve(args[6] || defaultFieldResolver, tracer, config) // fieldResolver
  args.length = Math.max(args.length, 7)

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

function startExecutionSpan (tracer, config, operation, args) {
  const span = startSpan(tracer, config, 'execute')

  addExecutionTags(span, config, operation, args.document, args.operationName)
  addDocumentTags(span, args.document, config)
  addVariableTags(tracer, config, span, args.variableValues)

  analyticsSampler.sample(span, config.measured, true)

  return span
}

function addExecutionTags (span, config, operation, document, operationName) {
  const type = operation && operation.operation
  const name = operation && operation.name && operation.name.value
  const tags = {
    'resource.name': getSignature(document, name, type, config.signature)
  }

  if (type) {
    tags['graphql.operation.type'] = type
  }

  if (name) {
    tags['graphql.operation.name'] = name
  }

  span.addTags(tags)
}

function addDocumentTags (span, document, config) {
  const tags = {}

  if (config.source && document && document._datadog_source) {
    tags['graphql.source'] = document._datadog_source
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

function startSpan (tracer, config, name, options) {
  options = options || {}

  return tracer.startSpan(`graphql.${name}`, {
    childOf: options.childOf || tracer.scope().active(),
    startTime: options.startTime,
    tags: {
      'service.name': getService(tracer, config),
      'span.type': 'graphql'
    }
  })
}

function startResolveSpan (tracer, config, childOf, path, info, contextValue) {
  const span = startSpan(tracer, config, 'resolve', { childOf })
  const document = contextValue._datadog_graphql.source
  const fieldNode = info.fieldNodes.find(fieldNode => fieldNode.kind === 'Field')

  analyticsSampler.sample(span, config.measured)

  span.addTags({
    'resource.name': `${info.fieldName}:${info.returnType}`,
    'graphql.field.name': info.fieldName,
    'graphql.field.path': path.join('.'),
    'graphql.field.type': info.returnType.name
  })

  if (fieldNode) {
    if (config.source && document && fieldNode.loc) {
      span.setTag('graphql.source', document.substring(fieldNode.loc.start, fieldNode.loc.end))
    }

    if (config.variables && fieldNode.arguments) {
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

function setError (span, error) {
  if (error) {
    span.setTag('error', error)
  }
}

function finish (span, finishTime) {
  span.finish(finishTime)
}

function finishResolvers (contextValue) {
  const fields = contextValue._datadog_graphql.fields

  Object.keys(fields).reverse().forEach(key => {
    const field = fields[key]

    setError(field.span, field.error)
    finish(field.span, field.finishTime)
  })
}

function updateField (field, error) {
  // TODO: update this to also work with no-op spans without a hack
  field.finishTime = field.span._getTime ? field.span._getTime() : 0
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
  const fields = contextValue._datadog_graphql.fields

  let field = fields[pathString]

  if (!field) {
    const parent = getParentField(tracer, contextValue, path)

    field = fields[pathString] = {
      parent,
      span: startResolveSpan(tracer, config, parent.span, path, info, contextValue),
      error: null
    }
  }

  return field
}

function getService (tracer, config) {
  return config.service || tracer._service
}

function getOperation (document, operationName) {
  if (!document || !Array.isArray(document.definitions)) {
    return
  }

  const definitions = document.definitions.filter(def => def)
  const types = ['query', 'mutation', 'subscription']

  if (operationName) {
    return definitions
      .filter(def => types.indexOf(def.operation) !== -1)
      .find(def => operationName === (def.name && def.name.value))
  } else {
    return definitions.find(def => types.indexOf(def.operation) !== -1)
  }
}

function validateConfig (config) {
  return Object.assign({}, config, {
    depth: getDepth(config),
    variables: getVariablesFilter(config),
    collapse: config.collapse === undefined || !!config.collapse,
    hooks: getHooks(config)
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

function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools = tools || require('./tools')
      } catch (e) {
        tools = false
        throw e
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch (e) {
      // safety net
    }
  }

  return [operationType, operationName].filter(val => val).join(' ')
}

function pathToArray (path) {
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

function getHooks (config) {
  const noop = () => {}
  const execute = (config.hooks && config.hooks.execute) || noop
  const parse = (config.hooks && config.hooks.parse) || noop
  const validate = (config.hooks && config.hooks.validate) || noop

  return { execute, parse, validate }
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
        execute.defaultFieldResolver
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
