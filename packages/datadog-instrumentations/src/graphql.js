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
const executeStartCh = channel('apm:graphql:execute:start')
const executeStartResolveCh = channel('apm:graphql:execute:resolve:start')
const executeCh = channel('apm:graphql:execute:execute')
const executeFinishExecuteCh = channel('apm:graphql:execute:finish')
const executeFinishResolveCh = channel('apm:graphql:execute:resolve:finish')
const executeUpdateFieldCh = channel('apm:graphql:execute:updateField')
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
function pathToArray (path) {
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

function withCollapse (responsePathAsArray) {
  return function () {
    return responsePathAsArray.apply(this, arguments)
      .map(segment => typeof segment === 'number' ? '*' : segment)
  }
}

function normalizeArgs (args, defaultFieldResolver, conf) {
  if (args.length !== 1) return normalizePositional(args, defaultFieldResolver, conf)

  args[0].contextValue = args[0].contextValue || {}
  args[0].fieldResolver = wrapResolve(args[0].fieldResolver || defaultFieldResolver, conf)

  return args[0]
}

function normalizePositional (args, defaultFieldResolver, conf) {
  args[3] = args[3] || {} // contextValue
  args[6] = wrapResolve(args[6] || defaultFieldResolver, conf) // fieldResolver

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

function wrapResolve (resolve, config) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  const responsePathAsArray = config.collapse
    ? withCollapse(pathToArray)
    : pathToArray

  function resolveAsync (_source, _args, contextValue, info) {
    const context = contexts.get(contextValue)

    AsyncResource.bind(resolve)
    if (!context) return resolve.apply(this, arguments)

    const path = responsePathAsArray(info && info.path)

    if (config.depth >= 0) {
      const depth = path.filter(item => typeof item === 'string').length

      if (config.depth < depth) {
        const parent = getParentField(context, path)

        return wrapFn(resolve, parent.asyncResource, this, arguments)
      }
    }
    const field = assertField(context, info, path)

    return wrapFn(resolve, field.asyncResource, this, arguments, (err) => {
      executeUpdateFieldCh.publish({ field, err })
    })
  }

  patchedResolvers.add(resolveAsync)

  return resolveAsync
}

function wrapFn (fn, aR, thisArg, args, cb) {
  cb = cb || (() => { })

  // might need a cb resource to make sure cb runs in same scope

  return aR.runInAsyncScope(() => {
    try {
      const result = fn.apply(thisArg, args)
      if (result && typeof result.then === 'function') {
        result.then(
          aR.bind(res => cb(null, res)),
          aR.bind(err => cb(err))
        )
      }
      return result
    } catch (err) {
      cb(err)
      throw err
    }
  })
}

function assertField (context, info, path) {
  const pathString = path.join('.')
  const fields = context.fields

  let field = fields[pathString]

  if (!field) {
    const parent = getParentField(context, path)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    asyncResource.runInAsyncScope(() => {
      executeStartResolveCh.publish({
        path,
        info,
        context
      })
    })

    field = fields[pathString] = {
      parent,
      asyncResource,
      error: null
    }
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

function wrapFields (type, conf) {
  if (!type || !type.fields || patchedTypes.has(type)) {
    return
  }

  patchedTypes.add(type)

  Object.keys(type._fields).forEach(key => {
    const field = type._fields[key]

    wrapFieldResolve(field, conf)
    wrapFieldType(field, conf)
  })
}

function wrapFieldResolve (field, conf) {
  if (!field || !field.resolve) return

  field.resolve = wrapResolve(field.resolve, conf)
}

function wrapFieldType (field, conf) {
  if (!field || !field.type) return

  let unwrappedType = field.type

  while (unwrappedType.ofType) {
    unwrappedType = unwrappedType.ofType
  }

  wrapFields(unwrappedType, conf)
}

function finishResolvers ({ fields }) {
  Object.keys(fields).reverse().forEach(key => {
    const field = fields[key]
    const asyncResource = field.asyncResource
    asyncResource.runInAsyncScope(() => {
      executeErrorCh.publish(field.error)
      executeFinishResolveCh.publish(field.finishTime)
    })
  })
}

addHook({ name: 'graphql', file: 'execution/execute.js', versions: ['>=0.10'] }, execute => {
  const defaultFieldResolver = execute.defaultFieldResolver
  const conf = {}

  shimmer.wrap(execute, 'execute', exe => function () {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      executeStartCh.publish(conf)
      const { config } = conf

      const args = normalizeArgs(arguments, defaultFieldResolver, config)
      const schema = args.schema
      const document = args.document
      const source = documentSources.get(document)
      const contextValue = args.contextValue
      const operation = getOperation(document, args.operationName)

      if (contexts.has(contextValue)) {
        return exe.apply(this, arguments)
      }

      if (schema) {
        wrapFields(schema._queryType, conf)
        wrapFields(schema._mutationType, conf)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      asyncResource.runInAsyncScope(() => {
        executeCh.publish({
          operation,
          args,
          docSource: documentSources.get(document)
        })
      })

      const context = { source, asyncResource, fields: {} }

      contexts.set(contextValue, context)

      return wrapFn(exe, asyncResource, this, arguments, (err, res) => {
        finishResolvers(context)

        executeErrorCh.publish(err || (res && res.errors && res.errors[0]))
        executeFinishExecuteCh.publish({ res, args }) // publish any errors and result in single call
      })
    })
  })
  return execute
})

addHook({ name: 'graphql', file: 'language/parser.js', versions: ['>=0.10'] }, parser => {
  shimmer.wrap(parser, 'parse', parse => function (source) {
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
  })
  return parser
})

addHook({ name: 'graphql', file: 'validation/validate.js', versions: ['>=0.10'] }, validate => {
  shimmer.wrap(validate, 'validate', val => function (_schema, document, _rules, _typeInfo) {
    if (!validateStartCh.hasSubscribers) {
      return val.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    asyncResource.runInAsyncScope(() => {
      validateStartCh.publish({ docSource: documentSources.get(document), document })

      let errors
      try {
        errors = val.apply(this, arguments)
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
  })

  return validate
})
