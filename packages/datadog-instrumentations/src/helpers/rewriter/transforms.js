'use strict'

// Custom transforms registered via InstrumentationMatcher.addTransform().
//
// Use this file for transforms that are not yet supported upstream in
// @apm-js-collab/code-transformer (Orchestrion) or that cannot land there
// for dd-trace-specific reasons. Once a transform is available natively in
// the library, replace the custom registration with the built-in option and
// remove the entry here.

const assert = require('node:assert')

const createRfdc = require('../../../../../vendor/dist/rfdc')
const clone = createRfdc({ proto: false, circles: false })

const { parse, query } = require('./compiler')

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])
const identifierPattern = /^[$A-Z_a-z][$\w]*$/
const POSTGRES_OPTIONS = '__ddTracePostgresOptions'
const POSTGRES_QUERY_REGISTRY = '__ddTracePostgresQueries'
const POSTGRES_QUERY_REGISTRY_SYMBOL = '__ddTracePostgresQueriesSymbol'
const POSTGRES_READY = '__ddTracePostgresQueryReady'
const POSTGRES_STATEMENT = 'this.string ?? (this.tagged && this.strings?.length !== 1 ? undefined : this.strings?.[0])'

module.exports = {
  awaitContextCallback,
  awaitContextCallbackAtFunctionStart,
  awaitContextCallbackAtTryStart,
  configureGraphqlJitCompileObject,
  configureGraphqlJitDeferredField,
  configureGraphqlJitExecute,
  configureGraphqlJitRuntime,
  configureGraphqlFastPath,
  configureMercuriusRequest,
  postgresQueryHandlers,
  postgresQueryLifecycle,
  waitForAsyncEnd,
}

/**
 * Awaits an optional context callback at the start of the matched node's enclosing async function.
 *
 * @param {Parameters<typeof awaitContextCallback>[0]} state
 * @param {import('estree').Node} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 * @returns {void}
 */
function awaitContextCallbackAtFunctionStart (state, node, _parent, ancestry) {
  let enclosingFunction = functionTypes.has(node.type)
    ? node
    : ancestry.find(ancestor => functionTypes.has(ancestor.type))
  let callbackAncestry = ancestry

  if (enclosingFunction === node) {
    callbackAncestry = [node, ...ancestry]
    if (!node.async) {
      // Function queries create a synchronous trace wrapper before custom transforms run.
      const [wrappedFunction] = query(node,
        'VariableDeclarator[id.name="__apm$traced"] > ArrowFunctionExpression > BlockStatement > ' +
        'VariableDeclaration > VariableDeclarator[id.name="__apm$wrapped"] > ' +
        ':matches(FunctionDeclaration, FunctionExpression)[async=true]')
      if (wrappedFunction) {
        enclosingFunction = wrappedFunction
        callbackAncestry.unshift(wrappedFunction)
      }
    }
  }
  assert(enclosingFunction?.async && enclosingFunction.body?.type === 'BlockStatement',
    'awaitContextCallbackAtFunctionStart: expected an enclosing async function with a block body')

  const generatedCallback = createAwaitedContextCallback(
    state,
    enclosingFunction.body,
    callbackAncestry,
    'awaitContextCallbackAtFunctionStart'
  )
  if (!generatedCallback) return

  let insertionIndex = 0
  while (typeof enclosingFunction.body.body[insertionIndex]?.directive === 'string') insertionIndex++
  enclosingFunction.body.body.splice(insertionIndex, 0, ...generatedCallback.callbackStatements)
}

/**
 * Starts a Postgres.js query at the pool handler that owns its connection options.
 *
 * @param {object} state
 * @param {import('estree').Program} program
 */
function postgresQueryHandlers (state, program) {
  const channelVariable = injectPostgresTracingChannel(state, program)
  injectPostgresReadyCheck(program, findPostgresQueryIdentifier(program))
  capturePostgresOptions(program)

  const handlers = query(program, 'FunctionDeclaration[id.name="handler"]')
  assert(handlers.length >= 2 && handlers.length <= 3, 'postgresQueryHandlers: unexpected handler count')

  for (const handler of handlers) {
    const queryParameter = handler.params[0]
    assert(queryParameter?.type === 'Identifier', 'postgresQueryHandlers: handler query parameter changed')
    wrapPostgresHandler(handler, queryParameter.name, channelVariable)
  }
}

/**
 * Publishes the final Postgres.js query settlement without changing its Promise implementation.
 *
 * @param {object} state
 * @param {import('estree').Program} program
 */
function postgresQueryLifecycle (state, program) {
  const channelVariable = injectPostgresTracingChannel(state, program)
  injectPostgresQueryRegistration(program)

  const resolveAssignments = query(
    program,
    'AssignmentExpression[left.object.type="ThisExpression"][left.property.name="resolve"]'
  )
  const rejectAssignments = query(
    program,
    'AssignmentExpression[left.object.type="ThisExpression"][left.property.name="reject"]'
  )

  assert(resolveAssignments.length === 2, 'postgresQueryLifecycle: unexpected resolve assignment count')
  assert(rejectAssignments.length === 2, 'postgresQueryLifecycle: unexpected reject assignment count')

  for (const assignment of resolveAssignments) {
    wrapPostgresResolution(assignment, channelVariable)
  }
  for (const assignment of rejectAssignments) {
    wrapPostgresRejection(assignment, channelVariable)
  }
}

/**
 * @param {import('estree').FunctionDeclaration|import('estree').ArrowFunctionExpression} handler
 * @param {string} queryParameter
 * @param {string} channelVariable
 */
function wrapPostgresHandler (handler, queryParameter, channelVariable) {
  assert(handler.body.type === 'BlockStatement', 'postgresQueryHandlers: handler body changed')
  assert(!handler.async && !handler.generator, 'postgresQueryHandlers: unsupported handler kind')

  const originalBody = handler.body.body
  const wrapperBody = parse(`
    function wrapper () {
      if (${channelVariable}.start.hasSubscribers && ${POSTGRES_READY} && !${queryParameter}.cancelled) {
        const __ddTraceContext = {
          query: ${queryParameter},
          database: ${POSTGRES_OPTIONS}.database,
          user: ${POSTGRES_OPTIONS}.user
        };
        if (${POSTGRES_OPTIONS}.host.length === 1 && !${POSTGRES_OPTIONS}.path) {
          __ddTraceContext.host = ${POSTGRES_OPTIONS}.host[0];
          __ddTraceContext.port = ${POSTGRES_OPTIONS}.port[0];
        }
        return ${channelVariable}.start.runStores(__ddTraceContext, () => {});
      }
    }
  `).body[0].body.body

  wrapperBody[0].consequent.body.at(-1).argument.arguments[1].body.body = originalBody
  handler.body.body = [...wrapperBody, ...originalBody]
}

/**
 * @param {import('estree').Program} program
 */
function capturePostgresOptions (program) {
  const postgresFunctions = query(program, 'FunctionDeclaration[id.name="Postgres"]')
  assert(postgresFunctions.length === 1, 'postgresQueryHandlers: Postgres function changed')

  const body = postgresFunctions[0].body.body
  const optionsIndex = body.findIndex(statement =>
    statement.type === 'VariableDeclaration' && statement.declarations.some(({ id }) => id.name === 'options')
  )
  assert(optionsIndex !== -1, 'postgresQueryHandlers: options declaration changed')

  const capture = parse(`const ${POSTGRES_OPTIONS} = options;`).body[0]
  body.splice(optionsIndex + 1, 0, capture)
}

/**
 * @param {import('estree').Program} program
 * @param {string} queryIdentifier
 */
function injectPostgresReadyCheck (program, queryIdentifier) {
  const statements = parse(`
    const ${POSTGRES_QUERY_REGISTRY} = globalThis[Symbol.for('dd-trace:postgres:query')];
    const ${POSTGRES_READY} = ${POSTGRES_QUERY_REGISTRY} instanceof WeakSet &&
      ${POSTGRES_QUERY_REGISTRY}.has(${queryIdentifier});
  `).body
  let importIndex = program.body.length - 1
  while (importIndex >= 0) {
    const statement = program.body[importIndex]
    if (statement.type === 'ImportDeclaration' || statement.type === 'VariableDeclaration') break
    importIndex--
  }

  program.body.splice(importIndex + 1, 0, ...statements)
}

/**
 * @param {import('estree').Program} program
 * @returns {string}
 */
function findPostgresQueryIdentifier (program) {
  const identifiers = []

  const imports = query(program, 'ImportDeclaration')
  for (const declaration of imports) {
    if (declaration.source.value !== './query.js') continue

    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'Query') {
        identifiers.push(specifier.local.name)
      }
    }
  }

  const declarations = query(program, 'VariableDeclarator[id.type="ObjectPattern"]')
  for (const declaration of declarations) {
    if (declaration.init?.type !== 'CallExpression' || declaration.init.callee.name !== 'require') continue
    if (declaration.init.arguments[0]?.value !== './query.js') continue

    for (const property of declaration.id.properties) {
      if (property.type === 'Property' && property.key.name === 'Query' && property.value.type === 'Identifier') {
        identifiers.push(property.value.name)
      }
    }
  }

  assert(identifiers.length === 1, 'postgresQueryHandlers: Query import changed')
  return identifiers[0]
}

/**
 * @param {import('estree').Program} program
 */
function injectPostgresQueryRegistration (program) {
  const queryClassIndex = program.body.findIndex(statement =>
    statement.type === 'VariableDeclaration' &&
      statement.declarations.some(({ id }) => id.type === 'Identifier' && id.name === 'Query') ||
      statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'ClassDeclaration' &&
        statement.declaration.id?.name === 'Query'
  )
  assert(queryClassIndex !== -1, 'postgresQueryLifecycle: Query class changed')

  const statements = parse(`
    const ${POSTGRES_QUERY_REGISTRY_SYMBOL} = Symbol.for('dd-trace:postgres:query');
    const ${POSTGRES_QUERY_REGISTRY} = globalThis[${POSTGRES_QUERY_REGISTRY_SYMBOL}] instanceof WeakSet
      ? globalThis[${POSTGRES_QUERY_REGISTRY_SYMBOL}]
      : (globalThis[${POSTGRES_QUERY_REGISTRY_SYMBOL}] = new WeakSet());
    ${POSTGRES_QUERY_REGISTRY}.add(Query);
  `).body
  program.body.splice(queryClassIndex + 1, 0, ...statements)
}

/**
 * @param {import('estree').AssignmentExpression} assignment
 * @param {string} channelVariable
 */
function wrapPostgresResolution (assignment, channelVariable) {
  const resolution = assignment.right
  assert(
    resolution.type === 'ArrowFunctionExpression' && resolution.body.type !== 'BlockStatement',
    'postgresQueryLifecycle: resolve function changed'
  )

  const originalBody = resolution.body
  const body = parse(`
    function wrapper () {
      if (${channelVariable}.asyncEnd.hasSubscribers && (!this.streaming || !this.active)) {
        const statement = ${POSTGRES_STATEMENT};
        ${channelVariable}.asyncEnd.publish({ query: this, statement, pid: this.state?.pid });
      }
      return undefined;
    }
  `).body[0].body
  resolution.body = body
  resolution.expression = false
  body.body.at(-1).argument = originalBody
}

/**
 * @param {import('estree').AssignmentExpression} assignment
 * @param {string} channelVariable
 */
function wrapPostgresRejection (assignment, channelVariable) {
  const rejection = assignment.right
  assert(
    rejection.type === 'ArrowFunctionExpression' &&
      rejection.body.type !== 'BlockStatement',
    'postgresQueryLifecycle: reject function changed'
  )
  const errorParameter = rejection.params[0]
  assert(errorParameter?.type === 'Identifier', 'postgresQueryLifecycle: reject parameter changed')

  const originalBody = rejection.body
  const body = parse(`
    function wrapper () {
      if (${channelVariable}.error.hasSubscribers || ${channelVariable}.asyncEnd.hasSubscribers) {
        const statement = ${POSTGRES_STATEMENT};
        const __ddTraceContext = { query: this, error: ${errorParameter.name}, statement, pid: this.state?.pid };
        if (${channelVariable}.error.hasSubscribers) {
          ${channelVariable}.error.publish(__ddTraceContext);
        }
        if (${channelVariable}.asyncEnd.hasSubscribers) {
          ${channelVariable}.asyncEnd.publish(__ddTraceContext);
        }
      }
      return undefined;
    }
  `).body[0].body
  rejection.body = body
  rejection.expression = false
  body.body.at(-1).argument = originalBody
}

/**
 * @param {object} state
 * @param {import('estree').Program} program
 * @returns {string}
 */
function injectPostgresTracingChannel (state, program) {
  state.transforms.tracingChannelDeclaration(state, program)

  const channelName = `orchestrion:${state.module.name}:${state.channelName}`
  const declarations = query(
    program,
    'VariableDeclarator[init.type="CallExpression"][init.callee.name="tr_ch_apm_tracingChannel"]'
  ).filter(({ init }) => init.arguments[0]?.value === channelName)

  assert(declarations.length === 1, 'postgres: tracing channel declaration changed')
  assert(declarations[0].id.type === 'Identifier', 'postgres: tracing channel identifier changed')
  return declarations[0].id.name
}

/**
 * Awaits an optional context callback before continuing through a matched conditional branch.
 *
 * The branch condition is checked again after the callback settles so the
 * original body does not run against state that changed while awaiting.
 *
 * @param {{
 *   transformOptions?: {
 *     callbackArgumentNames?: string[],
 *     callbackName?: string,
 *     callbackThis?: boolean
 *   }
 * }} state
 * @param {import('estree').IfStatement} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 * @returns {void}
 */
function awaitContextCallback (state, node, _parent, ancestry) {
  assert(node.type === 'IfStatement' && node.consequent?.type === 'BlockStatement',
    'awaitContextCallback: expected an if statement with a block body')

  const originalStatements = node.consequent.body
  const generatedCallback = createAwaitedContextCallback(
    state,
    node.consequent,
    ancestry,
    'awaitContextCallback'
  )
  if (!generatedCallback) return

  const { callbackStatements, callbackVariable } = generatedCallback
  const callbackBranch = parse(`
    if (typeof ${callbackVariable} === 'function') {
    } else {
    }
  `).body[0]
  callbackBranch.consequent.body.push(clone(node))
  callbackBranch.alternate = {
    type: 'BlockStatement',
    body: originalStatements,
  }
  node.consequent.body = [...callbackStatements, callbackBranch]
}

/**
 * Awaits an optional context callback before entering the matched node's enclosing try block.
 *
 * @param {Parameters<typeof awaitContextCallback>[0]} state
 * @param {import('estree').Node} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 * @returns {void}
 */
function awaitContextCallbackAtTryStart (state, node, _parent, ancestry) {
  let tryStatement = node.type === 'TryStatement' ? node : undefined
  for (const ancestor of ancestry) {
    if (tryStatement || functionTypes.has(ancestor.type)) break
    if (ancestor.type === 'TryStatement') tryStatement = ancestor
  }
  assert(tryStatement?.block?.type === 'BlockStatement',
    'awaitContextCallbackAtTryStart: expected an enclosing try statement with a block body')

  const generatedCallback = createAwaitedContextCallback(
    state,
    tryStatement.block,
    ancestry,
    'awaitContextCallbackAtTryStart'
  )
  if (!generatedCallback) return

  tryStatement.block.body.unshift(...generatedCallback.callbackStatements)
}

/**
 * @param {Parameters<typeof awaitContextCallback>[0]} state
 * @param {import('estree').BlockStatement} insertionTarget
 * @param {import('estree').Node[]} ancestry
 * @param {string} transformName
 * @returns {{
 *   callbackStatements: import('estree').Statement[],
 *   callbackVariable: string
 * }|undefined}
 */
function createAwaitedContextCallback (state, insertionTarget, ancestry, transformName) {
  const { callbackArgumentNames = [], callbackName, callbackThis = false } = state.transformOptions ?? {}

  assert(identifierPattern.test(callbackName), `${transformName}: callbackName must be an identifier`)
  assert(Array.isArray(callbackArgumentNames) && callbackArgumentNames.every(name => identifierPattern.test(name)),
    `${transformName}: callbackArgumentNames must be identifiers`)

  let enclosingFunction
  let hasTraceWrapper = false
  for (const ancestor of ancestry) {
    if (!functionTypes.has(ancestor.type)) continue

    enclosingFunction ??= ancestor
    if (ancestor.body?.type !== 'BlockStatement') continue

    let hasContextBinding = false
    let hasTracedBinding = false
    for (const statement of ancestor.body.body) {
      if (statement.type !== 'VariableDeclaration') continue

      for (const declaration of statement.declarations) {
        hasContextBinding ||= declaration.id?.name === '__apm$ctx'
        hasTracedBinding ||= declaration.id?.name === '__apm$traced'
      }
    }
    hasTraceWrapper ||= hasContextBinding && hasTracedBinding
  }

  assert(enclosingFunction?.async, `${transformName}: expected an enclosing async function`)
  assert(hasTraceWrapper, `${transformName}: expected an enclosing trace wrapper`)

  const callbackVariable = `__apm$${callbackName}`
  if (query(insertionTarget, `[id.name="${callbackVariable}"]`).length > 0) return

  const callbackArguments = callbackArgumentNames.join(', ')
  const callbackInvocation = callbackThis
    ? `${callbackVariable}.call(this${callbackArguments ? `, ${callbackArguments}` : ''})`
    : `${callbackVariable}(${callbackArguments})`
  const callbackStatements = parse(`
    async function wrapper () {
      let ${callbackVariable};
      try {
        ${callbackVariable} = __apm$ctx.${callbackName};
        if (typeof ${callbackVariable} === 'function') {
          await ${callbackInvocation};
        }
      } catch {}
    }
  `).body[0].body.body

  return {
    callbackStatements,
    callbackVariable,
  }
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitCompileObject (_state, node) {
  const resolverConditions = query(node, 'IfStatement[test.name="resolver"]')
  const compileTypeCalls = query(node, 'CallExpression[callee.name="compileType"]')

  assert.strictEqual(
    resolverConditions.length,
    1,
    'configureGraphqlJitCompileObject: resolver condition not found'
  )
  assert.strictEqual(
    compileTypeCalls.length,
    1,
    'configureGraphqlJitCompileObject: inline compile call not found'
  )

  const [resolverCondition] = resolverConditions
  const [compileTypeCall] = compileTypeCalls
  const inlineCompileCall = clone(compileTypeCall)
  const argumentProperties = query(resolverCondition.consequent, 'Property[key.name="args"]')
  assert.strictEqual(
    argumentProperties.length,
    1,
    'configureGraphqlJitCompileObject: argument compiler not found'
  )

  const defaultSetup = parse(`
    const ddTraceDefault = context.ddTraceDefaultResolvers && !resolver && alwaysDefer === false
    const ddTraceArguments = ddTraceDefault ? DD_ARGUMENTS : undefined
  `).body
  replaceIdentifier(defaultSetup[1], 'DD_ARGUMENTS', argumentProperties[0].value)
  const [inlineField] = parse(`
    const ddTraceInline = ddTraceDefault
      ? context.ddTraceRuntime.compileDefaultField(
        context,
        DD_PATH,
        type,
        field,
        DD_FIELD_NODES,
        originPaths,
        ddTraceArguments,
        objectStringify(ddTraceArguments.values),
        DD_COMPILED
      )
      : undefined
  `).body
  replaceIdentifier(inlineField, 'DD_PATH', clone(compileTypeCall.arguments[6]))
  replaceIdentifier(inlineField, 'DD_FIELD_NODES', clone(compileTypeCall.arguments[3]))
  replaceIdentifier(inlineField, 'DD_COMPILED', inlineCompileCall)

  assert(
    insertBeforeStatement(node.body, resolverCondition, [...defaultSetup, inlineField]),
    'configureGraphqlJitCompileObject: could not insert default field setup'
  )
  resolverCondition.test = parse('resolver || ddTraceDefault').body[0].expression

  const includedConditions = query(resolverCondition.consequent, 'IfStatement[test.name="alwaysIncluded"]')
  let defaultBody
  if (includedConditions.length === 1) {
    defaultBody = parse(`
      if (alwaysIncluded) {
        body(ddTraceInline)
      } else {
        body(\`? \${ddTraceInline} : undefined\`)
      }
    `).body
  } else {
    assert.strictEqual(
      includedConditions.length,
      0,
      'configureGraphqlJitCompileObject: ambiguous included condition'
    )
    defaultBody = parse(`
      body(\`? \${ddTraceInline} : undefined\`)
    `).body
  }

  const originalResolverBody = resolverCondition.consequent
  const [defaultCondition] = parse(`
    if (ddTraceDefault) {}
  `).body
  defaultCondition.consequent.body.push(...defaultBody)
  defaultCondition.alternate = originalResolverBody
  resolverCondition.consequent = {
    type: 'BlockStatement',
    body: [defaultCondition],
  }
}

/**
 * @param {import('estree').Node} root
 * @param {string} name
 * @param {import('estree').Node} replacement
 */
function replaceIdentifier (root, name, replacement) {
  for (const key of Object.keys(root)) {
    const value = root[key]
    if (!value || typeof value !== 'object') continue
    if (value.type === 'Identifier' && value.name === name) {
      root[key] = clone(replacement)
    } else {
      replaceIdentifier(value, name, replacement)
    }
  }
}

/**
 * @param {import('estree').Node} root
 * @param {import('estree').Node} target
 * @param {import('estree').Node[]} statements
 * @returns {boolean}
 */
function insertBeforeStatement (root, target, statements) {
  for (const key of Object.keys(root)) {
    const value = root[key]
    if (Array.isArray(value)) {
      const index = value.indexOf(target)
      if (index !== -1) {
        value.splice(index, 0, ...statements)
        return true
      }
      for (const entry of value) {
        if (entry && typeof entry === 'object' && insertBeforeStatement(entry, target, statements)) return true
      }
    } else if (value && typeof value === 'object' && insertBeforeStatement(value, target, statements)) {
      return true
    }
  }
  return false
}

/**
 * @param {import('estree').Node} root
 * @param {string} selector
 * @returns {import('estree').Node}
 */
function queryOne (root, selector) {
  const matches = query(root, selector)
  assert.strictEqual(matches.length, 1, `expected one match for ${selector}`)
  return matches[0]
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 * @param {import('estree').Node} parent
 * @param {import('estree').Node[]} ancestry
 */
function configureGraphqlFastPath (_state, node, parent, ancestry) {
  assert.strictEqual(node.type, 'FunctionDeclaration', 'configureGraphqlFastPath: expected a function declaration')
  assert(identifierPattern.test(node.id?.name), 'configureGraphqlFastPath: expected a named function')

  const insertionRoot = Array.isArray(parent?.body)
    ? parent
    : ancestry.find(ancestor => Array.isArray(ancestor?.body) && ancestor.body.includes(parent))
  assert(insertionRoot, 'configureGraphqlFastPath: expected an enclosing statement list')
  const insertionTarget = insertionRoot === parent ? node : parent

  const originalName = `__apm$original_${node.id.name}`
  assert.strictEqual(
    query(insertionRoot, `VariableDeclarator[id.name="${originalName}"]`).length,
    0,
    'configureGraphqlFastPath: original function binding already exists'
  )
  configureGraphqlTraceFastPath(
    node,
    insertionRoot,
    insertionTarget,
    originalName,
    'configureGraphqlFastPath'
  )
}

/**
 * @param {import('estree').Function} node
 * @param {import('estree').Node} insertionRoot
 * @param {import('estree').Node} insertionTarget
 * @param {string} originalName
 * @param {string} transformName
 */
function configureGraphqlTraceFastPath (node, insertionRoot, insertionTarget, originalName, transformName) {
  const tracedDeclaration = queryOne(
    node,
    'VariableDeclaration:has(VariableDeclarator[id.name="__apm$traced"])'
  )
  const tracedBody = queryOne(
    tracedDeclaration,
    'VariableDeclarator[id.name="__apm$traced"] > ArrowFunctionExpression > BlockStatement'
  )
  const wrappedDeclaration = queryOne(
    tracedBody,
    'VariableDeclaration:has(VariableDeclarator[id.name="__apm$wrapped"])'
  )
  const wrapped = queryOne(wrappedDeclaration, 'VariableDeclarator[id.name="__apm$wrapped"]')
  const subscriberGuard = queryOne(
    node,
    'IfStatement[test.operator="!"][consequent.type="ReturnStatement"]' +
      ':has(CallExpression[callee.name="__apm$traced"])'
  )
  const fastCall = subscriberGuard.consequent.argument
  const tracedCalls = query(node, 'CallExpression[callee.name="__apm$traced"]')
  assert.strictEqual(tracedCalls.length, 2, `${transformName}: expected inactive and active traced calls`)
  const activeCall = tracedCalls.find(call => call !== fastCall)
  assert(activeCall, `${transformName}: active traced call not found`)
  assert(functionTypes.has(wrapped.init?.type), `${transformName}: expected a wrapped function`)

  wrapped.id.name = originalName
  assert(
    insertBeforeStatement(insertionRoot, insertionTarget, [wrappedDeclaration]),
    `${transformName}: could not hoist original function`
  )

  fastCall.callee = parse(`${originalName}.apply`).body[0].expression
  fastCall.arguments = parse('call(this, arguments)').body[0].expression.arguments
  subscriberGuard.consequent = { type: 'BlockStatement', body: [subscriberGuard.consequent] }
  activeCall.callee = parse(`${originalName}.apply`).body[0].expression
  activeCall.arguments = parse('call(this, __apm$arguments)').body[0].expression.arguments

  const statements = node.body.body
  const subscriberGuardIndex = statements.indexOf(subscriberGuard)
  const tracedDeclarationIndex = statements.indexOf(tracedDeclaration)
  assert.notStrictEqual(subscriberGuardIndex, -1, `${transformName}: subscriber guard is not top-level`)
  assert.notStrictEqual(tracedDeclarationIndex, -1, `${transformName}: traced declaration is not top-level`)
  statements.splice(subscriberGuardIndex, 1)
  statements.splice(statements.indexOf(tracedDeclaration), 1)
  statements.unshift(subscriberGuard)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionExpression} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 */
function configureGraphqlJitExecute (_state, node, _parent, ancestry) {
  const context = queryOne(node, 'VariableDeclarator[id.name="__apm$ctx"] > ObjectExpression')
  const wrapped = queryOne(node, 'VariableDeclarator[id.name="__apm$wrapped"]')

  const createBoundQuery = ancestry.find(ancestor =>
    ancestor.type === 'FunctionDeclaration' && ancestor.id?.name === 'createBoundQuery'
  )
  assert(createBoundQuery, 'configureGraphqlJitExecute: createBoundQuery not found')

  const retDeclaration = queryOne(
    createBoundQuery,
    'VariableDeclaration:has(VariableDeclarator[id.name="ret"])'
  )
  assert.strictEqual(
    query(createBoundQuery, 'VariableDeclarator[id.name="__apm$wrapped"]').length,
    1,
    'configureGraphqlJitExecute: ambiguous wrapped query declaration'
  )
  assert.strictEqual(
    query(wrapped.init, 'ThisExpression, Super, MetaProperty, Identifier[name="arguments"]').length,
    0,
    'configureGraphqlJitExecute: original query depends on its invocation scope'
  )

  const bindings = parse(`
    const ddResolvers = compilationContext.resolvers
    const ddSchema = compilationContext.schema
  `).body
  const properties = parse(`({
    ddDocument: document,
    ddOperationName: operationName,
    ddPlan,
    ddResolvers,
    ddSchema
  })`).body[0].expression.properties

  context.properties.push(...properties)

  assert(
    insertBeforeStatement(createBoundQuery.body, retDeclaration, bindings),
    'configureGraphqlJitExecute: could not insert query bindings'
  )
  configureGraphqlTraceFastPath(
    node,
    createBoundQuery.body,
    retDeclaration,
    '__apm$wrapped',
    'configureGraphqlJitExecute'
  )
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitDeferredField (_state, node) {
  const declarations = query(node, 'VariableDeclaration:has(VariableDeclarator[id.name="resolverCall"])')
  const resolverCalls = query(node, 'VariableDeclarator[id.name="resolverCall"]')
  const executionErrorDeclarations = query(
    node,
    'VariableDeclaration:has(VariableDeclarator[id.name="executionError"])'
  )
  const executionErrors = query(node, 'VariableDeclarator[id.name="executionError"]')
  const emptyErrors = query(node, 'VariableDeclarator[id.name="emptyError"]')
  assert.strictEqual(
    declarations.length,
    1,
    'configureGraphqlJitDeferredField: resolver call declaration not found'
  )
  assert.strictEqual(
    resolverCalls.length,
    1,
    'configureGraphqlJitDeferredField: resolver call not found'
  )
  assert.strictEqual(
    executionErrorDeclarations.length,
    1,
    'configureGraphqlJitDeferredField: execution error declaration not found'
  )
  assert.strictEqual(executionErrors.length, 1, 'configureGraphqlJitDeferredField: execution error not found')
  assert.strictEqual(emptyErrors.length, 1, 'configureGraphqlJitDeferredField: empty error not found')

  const [resolverCall] = resolverCalls
  assertGraphqlJitResolverCall(resolverCall.init)

  const [descriptor] = parse(`
    const ddTraceDescriptorId = context.ddTraceRuntime?.registerField(context, responsePath, {
      fieldName,
      fieldNodes,
      returnType: fieldType,
      parentType
    })
  `).body
  assert(
    insertBeforeStatement(node.body, executionErrorDeclarations[0], [descriptor]),
    'configureGraphqlJitDeferredField: could not insert descriptor'
  )

  executionErrors[0].init.arguments[4] = parse(`
    ddTraceDescriptorId === undefined
      ? 'err'
      : '(__context.ddTrace?.jitRuntime.recordResolverError(__context.ddTrace, ' +
        ddTraceDescriptorId + ', err), err)'
  `).body[0].expression
  emptyErrors[0].init.arguments[3] = parse(`
    ddTraceDescriptorId === undefined
      ? '""'
      : '(__context.ddTrace?.jitRuntime.recordResolverError(__context.ddTrace, ' +
        ddTraceDescriptorId + ', err), "")'
  `).body[0].expression

  const replacement = parse(`
    context.ddTraceRuntime === undefined
      ? DD_CALL
      : context.ddTraceRuntime.compileResolverCall(context, DD_CALL, resolverName, ddTraceDescriptorId)
  `).body[0].expression
  replaceIdentifier(replacement, 'DD_CALL', resolverCall.init)
  resolverCall.init = replacement
}

/**
 * @param {import('estree').Expression | null} source
 */
function assertGraphqlJitResolverCall (source) {
  assert.strictEqual(source?.type, 'TemplateLiteral', 'configureGraphqlJitDeferredField: unsupported resolver call')

  const { expressions, quasis } = source
  assert.ok(expressions.length >= 2, 'configureGraphqlJitDeferredField: resolver call expressions not found')
  assert.ok(quasis.length >= 3, 'configureGraphqlJitDeferredField: resolver call segments not found')
  assert.strictEqual(
    expressions[0].name,
    'GLOBAL_EXECUTION_CONTEXT',
    'configureGraphqlJitDeferredField: execution context not found'
  )
  assert.strictEqual(
    quasis[1].value.raw,
    '.resolvers.',
    'configureGraphqlJitDeferredField: resolver map access not found'
  )
  assert.strictEqual(
    expressions[1].name,
    'resolverName',
    'configureGraphqlJitDeferredField: resolver name not found'
  )
  assert.ok(quasis[2].value.raw.startsWith('('), 'configureGraphqlJitDeferredField: resolver call not found')
  assert.ok(quasis.at(-1).value.raw.endsWith(')'), 'configureGraphqlJitDeferredField: resolver call end not found')
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitRuntime (_state, node) {
  node.body.body.unshift(...parse(`
    const ddTraceRuntime = compilationContext.ddTraceRuntime
    const ddPlan = ddTraceRuntime?.finalizeCompilation(compilationContext)
  `).body)

  const contexts = query(node, 'VariableDeclarator[id.name="executionContext"] > ObjectExpression')
  assert.strictEqual(
    contexts.length,
    1,
    'configureGraphqlJitRuntime: execution context not found'
  )

  const properties = parse(`({
    ddTrace: ddTraceRuntime?.startExecution(parsedVariables.coerced)
  })`).body[0].expression.properties
  contexts[0].properties.push(...properties)
}

/**
 * @param {object} _state
 * @param {import('estree').ObjectExpression} node
 */
function configureMercuriusRequest (_state, node) {
  const properties = parse('({ ddCacheLimit: opts.cache })').body[0].expression.properties
  node.properties.push(...properties)
}

/**
 * Injects settlement-specific asyncEnd waits into a generated `tracePromise`
 * wrapper's native-Promise handlers.
 *
 * @param {object} _state
 * @param {import('estree').CallExpression} node
 * @returns {void}
 */
function waitForAsyncEnd (_state, node) {
  const onFulfilled = node.arguments[0]
  const onRejected = node.arguments[1]

  if (!onFulfilled?.body || !onRejected?.body) {
    return
  }

  injectAsyncEndCallbackWait(onFulfilled.body, 'ReturnStatement', 'resolveCallback')
  injectAsyncEndCallbackWait(onRejected.body, 'ThrowStatement', 'rejectCallback')
}

/**
 * Injects a settlement-specific callback wait before an exit.
 *
 * @param {import('estree').BlockStatement} body
 * @param {'ReturnStatement'|'ThrowStatement'} exitType
 * @param {'resolveCallback'|'rejectCallback'} callbackProperty
 * @returns {void}
 */
function injectAsyncEndCallbackWait (body, exitType, callbackProperty) {
  const callbackVariable = `__apm$${callbackProperty}`
  if (query(body, `[id.name=${callbackVariable}]`).length > 0) {
    return
  }

  const exitIndex = body.body.findIndex(statement =>
    statement.type === exitType && statement.argument
  )

  // The generated settlement handlers always end in a return or throw; a miss means the
  // upstream template changed and the caller's try/catch falls back to the
  // unwrapped source.
  assert(exitIndex !== -1, `waitForAsyncEnd: no ${exitType} to wait on`)

  // This runs inside tracePromise's native-Promise settlement handler. The
  // Promise adapts subscriber callback completion to that existing chain.
  const waitStatements = parse(`
    function wrapper () {
      const ${callbackVariable} = __apm$ctx.${callbackProperty};
      if (typeof ${callbackVariable} === 'function') {
        return new Promise(${callbackVariable}).then(() => __apm$result, () => __apm$result);
      }
    }
  `).body[0].body.body

  const exitArgument = body.body[exitIndex].argument
  const callbackIf = waitStatements[1]
  const { arguments: onCallbackSettled } = callbackIf.consequent.body[0].argument

  if (exitType === 'ThrowStatement') {
    for (const handler of onCallbackSettled) {
      handler.body = {
        type: 'BlockStatement',
        body: [{
          type: 'ThrowStatement',
          argument: clone(exitArgument),
        }],
      }
    }
  } else {
    onCallbackSettled[0].body = clone(exitArgument)
    onCallbackSettled[1].body = clone(exitArgument)
  }

  body.body.splice(exitIndex, 0, ...waitStatements)
}
