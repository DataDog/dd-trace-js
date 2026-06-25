'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
  channel,
} = require('./helpers/instrument')

const ddGlobal = globalThis[Symbol.for('dd-trace')]

/** cached objects */

// `contexts` is the fast resolver-side lookup; `executeCtx` is the fallback
// when `contextValue` is a primitive and cannot key a WeakMap.
const contexts = new WeakMap()
const executeCtx = new AsyncLocalStorage()
// Tracks normalized args already instrumented in an outer wrap so graphql-yoga
// (which stacks `execute` + `normalizedExecutor`) only emits one span per call.
const instrumentedArgs = new WeakSet()
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

  const original = args[0]
  const normalized = {
    ...original,
    fieldResolver: wrapResolve(original.fieldResolver || defaultFieldResolver),
  }

  args[0] = normalized
  return normalized
}

function normalizePositional (args, defaultFieldResolver) {
  args[6] = wrapResolve(args[6] || defaultFieldResolver) // fieldResolver
  args.length = Math.max(args.length, 7)

  return {
    schema: args[0],
    document: args[1],
    rootValue: args[2],
    contextValue: args[3],
    variableValues: args[4],
    operationName: args[5],
    fieldResolver: args[6],
  }
}

// `WeakMap.set` throws `TypeError` on a non-object key; `get`/`has`/`delete`
// silently miss. Skip the WeakMap entirely for non-keyable `contextValue`.
function isWeakMapKey (value) {
  return value !== null && typeof value === 'object'
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
        void err.stack
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
          ctx.error = errors[0]
          validateErrorCh.publish(ctx)
        }
        return errors
      } catch (err) {
        void err.stack
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

      // The outer wrap leaves its normalized args object in `arguments[0]`; on
      // graphql-yoga's inner wrap that reference is already known here.
      if (instrumentedArgs.has(arguments[0])) {
        return exe.apply(this, arguments)
      }

      const args = normalizeArgs(arguments, defaultFieldResolver)
      const schema = args.schema
      const document = args.document
      const source = documentSources.get(document)
      const contextValue = args.contextValue
      const keyable = isWeakMapKey(contextValue)
      const operation = getOperation(document, args.operationName)

      if (keyable && contexts.has(contextValue)) {
        return exe.apply(this, arguments)
      }

      const ctx = {
        operation,
        args,
        docSource: source,
        source,
        fields: new Map(),
        abortController: new AbortController(),
      }

      // Only the object form leaves a stable single-object handle in
      // `arguments[0]` for the inner wrap to see.
      if (args === arguments[0]) instrumentedArgs.add(args)

      return startExecuteCh.runStores(ctx, () => {
        if (schema) {
          wrapFields(schema._queryType)
          wrapFields(schema._mutationType)
        }

        if (keyable) contexts.set(contextValue, ctx)

        const finish = (err, res) => {
          if (finishResolveCh.hasSubscribers) finishResolvers(ctx)

          const error = err || (res && res.errors && res.errors[0])

          if (error) {
            ctx.error = error
            executeErrorCh.publish(ctx)
          }

          ctx.res = res
          if (keyable) contexts.delete(contextValue)
          instrumentedArgs.delete(args)
          finishExecuteCh.publish(ctx)
        }

        // Skip the ALS entry on the common object-`contextValue` path; the
        // resolver reaches `ctx` via the WeakMap there.
        return keyable
          ? callInAsyncScope(exe, this, arguments, ctx.abortController, finish)
          : executeCtx.run(ctx, () => callInAsyncScope(exe, this, arguments, ctx.abortController, finish))
      })
    }
  }
}

function wrapResolve (resolve) {
  if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return resolve

  function resolveAsync (source, args, contextValue, info) {
    if (!startResolveCh.hasSubscribers) return resolve.apply(this, arguments)

    // `WeakMap.get(primitive)` returns `undefined`, so the fallback covers
    // executes that ran with a primitive `contextValue`.
    const ctx = contexts.get(contextValue) ?? executeCtx.getStore()

    /* istanbul ignore if: resolver invoked outside execute(), so no per-execute ctx was registered */
    if (!ctx) return resolve.apply(this, arguments)

    const field = assertField(ctx, info, args)

    if (ctx.abortController.signal.aborted) {
      publishResolverFinish(field, null)
      throw new AbortError('Aborted')
    }

    try {
      const result = resolve.call(this, source, args, contextValue, info)
      if (result !== null && typeof result?.then === 'function') {
        return result.then(
          res => {
            publishResolverFinish(field, null)
            return res
          },
          error => {
            publishResolverFinish(field, error)
            throw error
          }
        )
      }
      publishResolverFinish(field, null)
      return result
    } catch (error) {
      publishResolverFinish(field, error)
      throw error
    }
  }

  patchedResolvers.add(resolveAsync)

  return resolveAsync
}

/**
 * @param {{ ctx: object, error: unknown }} field
 * @param {unknown} error
 */
function publishResolverFinish (field, error) {
  const fieldCtx = field.ctx
  fieldCtx.error = error
  fieldCtx.field = field
  updateFieldCh.publish(fieldCtx)
}

function callInAsyncScope (fn, thisArg, args, abortController, cb) {
  if (abortController.signal.aborted) {
    cb(null, null)
    throw new AbortError('Aborted')
  }

  try {
    const result = fn.apply(thisArg, args)
    if (result !== null && typeof result?.then === 'function') {
      return result.then(
        res => {
          cb(null, res)
          return res
        },
        /* istanbul ignore next: graphql.execute() rejects only via custom executors (graphql-yoga / graphql-tools) */
        error => {
          cb(error)
          throw error
        }
      )
    }
    cb(null, result)
    return result
  } catch (error) {
    cb(error)
    throw error
  }
}

/**
 * @typedef {{ prev: PathNode | undefined, key: string | number }} PathNode
 *
 * @typedef {{ error: unknown, ctx: object }} TrackedField
 */

/**
 * @param {{
 *   fields: Map<object, TrackedField>,
 *   collapse: boolean,
 *   collapsedFields?: Map<string, TrackedField>,
 *   pathCache?: Map<PathNode, string>,
 * }} rootCtx
 * @param {import('graphql').GraphQLResolveInfo} info
 * @param {Record<string, unknown>} args
 */
function assertField (rootCtx, info, args) {
  const path = info.path
  const collapse = rootCtx.collapse

  const cache = rootCtx.pathCache ??= new Map()
  const prev = path.prev
  const key = path.key
  const segment = collapse && typeof key !== 'string' ? '*' : key

  const pathString = prev === undefined
    ? String(segment)
    : (cache.get(prev) ?? buildCachedPathString(prev, cache, collapse)) + '.' + segment
  cache.set(path, pathString)

  const rv = info.variableValues
  const fieldCtx = {
    rootCtx,
    args,
    path,
    pathString,
    fieldName: info.fieldName,
    returnType: info.returnType,
    fieldNode: info.fieldNodes[0],
    // graphql v17 changed variableValues to { sources, coerced }; normalize to flat object
    variableValues: (rv != null && typeof rv.coerced === 'object' && rv.coerced !== null) ? rv.coerced : rv,
  }
  // Publish per resolver call, before the collapse / depth dedupe below.
  // IAST mutates each call's own args object; if siblings 2..N skip the
  // publish, those args objects never get tainted.
  startResolveCh.publish(fieldCtx)

  let collapsedFields
  if (collapse) {
    collapsedFields = rootCtx.collapsedFields ??= new Map()
    const existing = collapsedFields.get(pathString)
    // Subsequent siblings of a collapsed list share the first sibling's field
    // so updateFieldCh fires for every call and the span's finishTime tracks
    // the last sibling's completion, not the first.
    if (existing !== undefined) return existing
  }

  const field = { error: null, ctx: fieldCtx }
  rootCtx.fields.set(path, field)
  if (collapsedFields !== undefined) collapsedFields.set(pathString, field)
  return field
}

/**
 * Cold path for assertField. graphql-js inserts a synthetic array-index
 * node between a list field and its items, and that node never reaches a
 * resolver — so assertField has no chance to cache it. The first child of
 * the list item that hits the path cache lands here to walk and populate
 * back to a cached ancestor.
 *
 * @param {PathNode} path
 * @param {Map<PathNode, string>} cache
 * @param {boolean} collapse
 */
function buildCachedPathString (path, cache, collapse) {
  const key = path.key
  const segment = collapse && typeof key !== 'string' ? '*' : key
  const prev = path.prev

  const pathString = prev === undefined
    ? String(segment)
    : (cache.get(prev) ?? buildCachedPathString(prev, cache, collapse)) + '.' + segment
  cache.set(path, pathString)
  return pathString
}

function wrapFields (type) {
  if (!type || !type._fields || patchedTypes.has(type)) {
    return
  }

  patchedTypes.add(type)

  for (const field of Object.values(type._fields)) {
    wrapFieldResolve(field)
    wrapFieldType(field)
  }
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
  for (const field of fields.values()) {
    const fieldCtx = field.ctx
    // A depth-gated field publishes startResolveCh for IAST/AppSec but the
    // resolve plugin's start short-circuits before creating a span, so there
    // is no span here to finish.
    if (fieldCtx.currentStore === undefined) continue
    fieldCtx.finishTime = field.finishTime
    fieldCtx.field = field
    if (field.error) {
      fieldCtx.error = field.error
      resolveErrorCh.publish(fieldCtx)
    }
    finishResolveCh.publish(fieldCtx)
  }
}

addHook({ name: '@graphql-tools/executor', versions: ['>=0.0.14'] }, executor => {
  // graphql-yoga uses the normalizedExecutor function, so we need to wrap both. There is no risk in wrapping both
  // since the functions are closely related, and our wrappedExecute function prevents double calls with the
  // contexts.has(contextValue) check.
  shimmer.wrap(executor, 'execute', wrapExecute(executor))
  shimmer.wrap(executor, 'normalizedExecutor', wrapExecute(executor))
  return executor
})

// TODO(BridgeAR): graphql >=17.0.0-alpha.9 routes execute() through
// experimentalExecuteIncrementally(), bypassing this hook. The same
// function returns { initialResult, subsequentResults } for @defer /
// @stream which callInAsyncScope does not handle — execute finishes
// before the streamed payloads land.
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

addHook({ name: 'graphql', file: 'language/printer.js', versions: ['>=0.10'] }, printer => {
  // HACK: It's possible `graphql` is loaded before `@apollo/gateway` so we
  //       can't use a channel as the latter plugin would load after the publish
  //       happened. Not sure how to handle this so for now use a global.
  ddGlobal.graphql_printer = printer
  return printer
})

addHook({ name: 'graphql', file: 'language/visitor.js', versions: ['>=0.10'] }, visitor => {
  ddGlobal.graphql_visitor = visitor
  return visitor
})

addHook({ name: 'graphql', file: 'utilities/index.js', versions: ['>=0.10'] }, utilities => {
  ddGlobal.graphql_utilities = utilities
  return utilities
})
