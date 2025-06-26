'use strict'

const {
  addHook,
  channel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

/** cached objects */

const contexts = new WeakMap()
const documentSources = new WeakMap()
const patchedResolvers = new WeakSet()
const patchedTypes = new WeakSet()

/** CHANNELS */

// execute channels
const startExecuteCh = channel('apm:graphql:execute:start')
const finishExecuteCh = channel('apm:graphql:execute:finish')
const executeErrorCh = channel('apm:graphql:execute:error')

// resolve channels
const startResolveCh = channel('apm:graphql:resolve:start')
const finishResolveCh = channel('apm:graphql:resolve:finish')
const updateFieldCh = channel('apm:graphql:resolve:updateField')
const resolveErrorCh = channel('apm:graphql:resolve:error')

// parse channels
const parseStartCh = channel('apm:graphql:parser:start')
const parseFinishCh = channel('apm:graphql:parser:finish')
const parseErrorCh = channel('apm:graphql:parser:error')

// validate channels
const validateStartCh = channel('apm:graphql:validate:start')
const validateFinishCh = channel('apm:graphql:validate:finish')
const validateErrorCh = channel('apm:graphql:validate:error')

class AbortError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AbortError'
  }
}

const types = new Set(['query', 'mutation', 'subscription'])

function getOperation (document, operationName) {
  if (!document || !Array.isArray(document.definitions)) {
    return
  }

  for (const definition of document.definitions) {
    if (definition && types.has(definition.operation) && (!operationName || definition.name?.value === operationName)) {
      return definition
    }
  }
}

function normalizeArgs (args, defaultFieldResolver) {
  if (args.length !== 1) return normalizePositional(args, defaultFieldResolver)

  args[0].contextValue ||= {}
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

    const ctx = {}
    return parseStartCh.runStores(ctx, () => {
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
        ctx.error = err
        parseErrorCh.publish(ctx)

        throw err
      } finally {
        parseFinishCh.publish({ source, document, docSource: documentSources.get(document), ...ctx })
      }
    })
  }
}

function wrapValidate (validate) {
  return function (_schema, document, _rules, _typeInfo) {
    if (!validateStartCh.hasSubscribers) {
      return validate.apply(this, arguments)
    }

    const ctx = { docSource: documentSources.get(document), document }
    return validateStartCh.runStores(ctx, () => {
      let errors
      try {
        errors = validate.apply(this, arguments)
        if (errors && errors[0]) {
          ctx.error = errors && errors[0]
          validateErrorCh.publish(ctx)
        }
        return errors
      } catch (err) {
        err.stack
        ctx.error = err
        validateErrorCh.publish(ctx)

        throw err
      } finally {
        validateFinishCh.publish({ errors, ...ctx })
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

      const args = normalizeArgs(arguments, defaultFieldResolver)
      const schema = args.schema
      const document = args.document
      const source = documentSources.get(document)
      const contextValue = args.contextValue
      const operation = getOperation(document, args.operationName)

      const ctx = { operation, args, docSource: documentSources.get(document) }
      return startExecuteCh.runStores(ctx, () => {
        if (contexts.has(contextValue)) {
          return exe.apply(this, arguments)
        }

        if (schema) {
          wrapFields(schema._queryType)
          wrapFields(schema._mutationType)
        }

        const context = { source, fields: {}, abortController: new AbortController(), ...ctx }

        contexts.set(contextValue, context)

        return callInAsyncScope(exe, this, arguments, context.abortController, (err, res) => {
          if (finishResolveCh.hasSubscribers) finishResolvers(context)

          const error = err || (res && res.errors && res.errors[0])

          if (error) {
            ctx.error = error
            executeErrorCh.publish(ctx)
          }

          ctx.res = res
          finishExecuteCh.publish(ctx)
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

    const field = assertField(context, info, args)

    return callInAsyncScope(resolve, this, arguments, context.abortController, (err) => {
      updateFieldCh.publish({ field, info, err, ...field.ctx })
    })
  }

  patchedResolvers.add(resolveAsync)

  return resolveAsync
}

function callInAsyncScope (fn, thisArg, args, abortController, cb) {
  cb = cb || (() => {})

  if (abortController?.signal.aborted) {
    cb(null, null)
    throw new AbortError('Aborted')
  }

  try {
    const result = fn.apply(thisArg, args)
    if (result && typeof result.then === 'function') {
      // bind callback to this scope
      result.then(
        res => cb(null, res),
        err => cb(err)
      )
    } else {
      cb(null, result)
    }
    return result
  } catch (err) {
    cb(err)
    throw err
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

function assertField (context, info, args) {
  const pathInfo = info && info.path

  const path = pathToArray(pathInfo)

  const pathString = path.join('.')
  const fields = context.fields

  let field = fields[pathString]

  if (!field) {
    const parent = getParentField(context, path)
    // we need to pass the parent span to the field if it exists for correct span parenting
    // of nested fields
    const ctx = { info, context, args, childOf: parent?.ctx?.currentStore?.span }
    startResolveCh.publish(ctx)
    field = fields[pathString] = {
      parent,
      error: null,
      ctx
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
    const ctx = { field, finishTime: field.finishTime, ...field.ctx }
    if (field.error) {
      ctx.error = field.error
      resolveErrorCh.publish(ctx)
    }
    finishResolveCh.publish(ctx)
  })
}

addHook({ name: '@graphql-tools/executor', file: 'cjs/execution/execute.js', versions: ['>=0.0.14'] }, execute => {})

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
