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

    const ctx = { source }
    return parseStartCh.runStores(ctx, () => {
      try {
        ctx.document = parse.apply(this, arguments)
        const operation = getOperation(ctx.document)

        if (!operation) return ctx.document

        if (source) {
          documentSources.set(ctx.document, source.body || source)
        }
        ctx.docSource = documentSources.get(ctx.document)

        return ctx.document
      } catch (err) {
        err.stack
        ctx.error = err
        parseErrorCh.publish(ctx)

        throw err
      } finally {
        parseFinishCh.publish(ctx)
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
        ctx.errors = errors
        validateFinishCh.publish(ctx)
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

      if (contexts.has(contextValue)) {
        return exe.apply(this, arguments)
      }

      const ctx = {
        operation,
        args,
        docSource: documentSources.get(document),
        source,
        fields: {},
        abortController: new AbortController()
      }

      return startExecuteCh.runStores(ctx, () => {
        if (schema) {
          wrapFields(schema._queryType)
          wrapFields(schema._mutationType)
        }

        contexts.set(contextValue, ctx)

        return callInAsyncScope(exe, this, arguments, ctx.abortController, (err, res) => {
          if (finishResolveCh.hasSubscribers) finishResolvers(ctx)

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

    const ctx = contexts.get(contextValue)

    if (!ctx) return resolve.apply(this, arguments)

    const field = assertField(ctx, info, args)

    return callInAsyncScope(resolve, this, arguments, ctx.abortController, (err) => {
      field.ctx.error = err
      field.ctx.info = info
      field.ctx.field = field
      updateFieldCh.publish(field.ctx)
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

function assertField (rootCtx, info, args) {
  const pathInfo = info && info.path

  const path = pathToArray(pathInfo)

  const pathString = path.join('.')
  const fields = rootCtx.fields

  let field = fields[pathString]

  if (!field) {
    const fieldCtx = { info, rootCtx, args }
    startResolveCh.publish(fieldCtx)
    field = fields[pathString] = {
      error: null,
      ctx: fieldCtx
    }
  }

  return field
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
    field.ctx.finishTime = field.finishTime
    field.ctx.field = field
    if (field.error) {
      field.ctx.error = field.error
      resolveErrorCh.publish(field.ctx)
    }
    finishResolveCh.publish(field.ctx)
  })
}

addHook({ name: '@graphql-tools/executor', versions: ['>=0.0.14'] }, executor => {
  // graphql-yoga uses the normalizedExecutor function, so we need to wrap both. There is no risk in wrapping both
  // since the functions are closely related, and our wrappedExecute function prevents double calls with the
  // contexts.has(contextValue) check.
  shimmer.wrap(executor, 'execute', wrapExecute(executor))
  shimmer.wrap(executor, 'normalizedExecutor', wrapExecute(executor))
  return executor
})

addHook({ name: '@graphql-tools/executor', file: 'cjs/execution/execute.js', versions: ['>=0.0.14'] }, execute => {
  shimmer.wrap(execute, 'execute', wrapExecute(execute))
  return execute
})

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
