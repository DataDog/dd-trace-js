'use strict'

const {
  addHook,
  channel,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

/** cached objects */

const contexts = new WeakMap()
const documentSources = new WeakMap()
const patchedResolvers = new WeakSet()
const patchedTypes = new WeakSet()

/** CHANNELS */

// execute channels
const startResolveCh = channel('apm:graphql:resolve:start')
const startExecuteCh = channel('apm:graphql:execute:start')
const finishExecuteCh = channel('apm:graphql:execute:finish')
const finishResolveCh = channel('apm:graphql:resolve:finish')
const updateFieldCh = channel('apm:graphql:resolve:updateField')
const executeErrorCh = channel('apm:graphql:execute:error')

// parse channels
const parseStartCh = channel('apm:graphql:parser:start')
const parseFinishCh = channel('apm:graphql:parser:finish')
const parseErrorCh = channel('apm:graphql:parser:error')

// validate channels
const validateStartCh = channel('apm:graphql:validate:start')
const validateFinishCh = channel('apm:graphql:validate:finish')
const validateErrorCh = channel('apm:graphql:validate:error')

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

function normalizeArgs (args, defaultFieldResolver) {
  if (args.length !== 1) return normalizePositional(args, defaultFieldResolver)

  args[0].contextValue = args[0].contextValue || {}
  args[0].fieldResolver = wrapResolve(args[0].fieldResolver || defaultFieldResolver)

  return args[0]
}

function normalizePositional (args, defaultFieldResolver) {
  args[3] = args[3] || {} // contextValue
  args[6] = wrapResolve(args[6] || defaultFieldResolver) // fieldResolver
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

function wrapParse (parse) {
  return function (source) {
    if (!parseStartCh.hasSubscribers) {
      return parse.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      parseStartCh.publish()
      let document
      try {
        document = parse.apply(this, arguments)
        const operation = getOperation(document)

        if (!operation) return document

        if (source) {
          documentSources.set(document, source.body || source)
        }

        return document
      } catch (err) {
        err.stack
        parseErrorCh.publish(err)

        throw err
      } finally {
        parseFinishCh.publish({ source, document, docSource: documentSources.get(document) })
      }
    })
  }
}

function wrapValidate (validate) {
  return function (_schema, document, _rules, _typeInfo) {
    if (!validateStartCh.hasSubscribers) {
      return validate.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      validateStartCh.publish({ docSource: documentSources.get(document), document })

      let errors
      try {
        errors = validate.apply(this, arguments)
        validateErrorCh.publish(errors && errors[0])
        return errors
      } catch (err) {
        err.stack
        validateErrorCh.publish(err)

        throw err
      } finally {
        validateFinishCh.publish({ document, errors })
      }
    })
  }
}

function wrapExecute (execute) {
  return function (exe) {
    const defaultFieldResolver = execute.defaultFieldResolver
    return function () {
      if (!startExecuteCh.hasSubscribers) {
        return exe.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(() => {
        const args = normalizeArgs(arguments, defaultFieldResolver)
        const schema = args.schema
        const document = args.document
        const source = documentSources.get(document)
        const contextValue = args.contextValue
        const operation = getOperation(document, args.operationName)

        if (contexts.has(contextValue)) {
          return exe.apply(this, arguments)
        }

        if (schema) {
          wrapFields(schema._queryType)
          wrapFields(schema._mutationType)
        }

        startExecuteCh.publish({
          operation,
          args,
          docSource: documentSources.get(document)
        })

        const context = { source, asyncResource, fields: {} }

        contexts.set(contextValue, context)

        return callInAsyncScope(exe, asyncResource, this, arguments, (err, res) => {
          if (finishResolveCh.hasSubscribers) finishResolvers(context)

          executeErrorCh.publish(err || (res && res.errors && res.errors[0]))
          finishExecuteCh.publish({ res, args })
        })
      })
    }
  }
}

function wrapResolve (resolve) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  function resolveAsync (source, args, contextValue, info) {
    if (!startResolveCh.hasSubscribers) return resolve.apply(this, arguments)

    const context = contexts.get(contextValue)

    if (!context) return resolve.apply(this, arguments)

    const field = assertField(context, info)

    return callInAsyncScope(resolve, field.asyncResource, this, arguments, (err) => {
      updateFieldCh.publish({ field, info, err })
    })
  }

  patchedResolvers.add(resolveAsync)

  return resolveAsync
}

function callInAsyncScope (fn, aR, thisArg, args, cb) {
  cb = cb || (() => {})

  return aR.runInAsyncScope(() => {
    try {
      const result = fn.apply(thisArg, args)
      if (result && typeof result.then === 'function') {
        // bind callback to this scope
        result.then(
          aR.bind(res => cb(null, res)),
          aR.bind(err => cb(err))
        )
      } else {
        cb(null, result)
      }
      return result
    } catch (err) {
      cb(err)
      throw err
    }
  })
}

function pathToArray (path, includeNumbers = true) {
  const flattened = []
  let curr = path
  while (curr) {
    const key = curr.key
    flattened.push(key)
    if (typeof key === 'number' && !includeNumbers) flattened.splice(-1)
    curr = curr.prev
  }
  return flattened.reverse()
}

function assertField (context, info) {
  const pathInfo = info && info.path

  const path = pathToArray(pathInfo)

  const pathString = path.join('.')
  const fields = context.fields

  let field = fields[pathString]

  if (!field) {
    const parent = getParentField(context, path)

    // we want to spawn the new span off of the parent, not a new async resource
    parent.asyncResource.runInAsyncScope(() => {
      /* this child resource will run a branched scope off of the parent resource, which
      accesses the parent span from the storage unit in its own scope */
      const childResource = new AsyncResource('bound-anonymous-fn')

      childResource.runInAsyncScope(() => {
        startResolveCh.publish({
          info,
          context
        })
      })

      field = fields[pathString] = {
        parent,
        asyncResource: childResource,
        error: null
      }
    })
  }

  return field
}

function getParentField (context, path) {
  for (let i = path.length - 1; i > 0; i--) {
    const field = getField(context, path.slice(0, i))
    if (field) {
      return field
    }
  }

  return {
    asyncResource: context.asyncResource
  }
}

function getField (context, path) {
  return context.fields[path.join('.')]
}

function wrapFields (type) {
  if (!type || !type._fields || patchedTypes.has(type)) {
    return
  }

  patchedTypes.add(type)

  Object.keys(type._fields).forEach(key => {
    const field = type._fields[key]

    wrapFieldResolve(field)
    wrapFieldType(field)
  })
}

function wrapFieldResolve (field) {
  if (!field || !field.resolve) return
  field.resolve = wrapResolve(field.resolve)
}

function wrapFieldType (field) {
  if (!field || !field.type) return

  let unwrappedType = field.type

  while (unwrappedType.ofType) {
    unwrappedType = unwrappedType.ofType
  }

  wrapFields(unwrappedType)
}

function finishResolvers ({ fields }) {
  Object.keys(fields).reverse().forEach(key => {
    const field = fields[key]
    const asyncResource = field.asyncResource
    asyncResource.runInAsyncScope(() => {
      executeErrorCh.publish(field.error)
      finishResolveCh.publish(field.finishTime)
    })
  })
}

addHook({ name: 'graphql', file: 'execution/execute.js', versions: ['>=0.10'] }, execute => {
  shimmer.wrap(execute, 'execute', wrapExecute(execute))
  return execute
})

addHook({ name: 'graphql', file: 'language/parser.js', versions: ['>=0.10'] }, parser => {
  shimmer.wrap(parser, 'parse', wrapParse)
  return parser
})

addHook({ name: 'graphql', file: 'validation/validate.js', versions: ['>=0.10'] }, validate => {
  shimmer.wrap(validate, 'validate', wrapValidate)

  return validate
})
