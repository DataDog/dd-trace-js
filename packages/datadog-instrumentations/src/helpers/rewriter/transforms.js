'use strict'

// Custom transforms registered via InstrumentationMatcher.addTransform().
//
// Use this file for transforms that are not yet supported upstream in
// @apm-js-collab/code-transformer (Orchestrion) or that cannot land there
// for dd-trace-specific reasons. Once a transform is available natively in
// the library, replace the custom registration with the built-in option and
// remove the entry here.

const assert = require('node:assert')

const clone = require('../../../../../vendor/dist/rfdc')({ proto: false, circles: false })

const { parse, query } = require('./compiler')

module.exports = {
  configureGraphqlJitCompileObject,
  configureGraphqlJitExecute,
  configureGraphqlJitExecutionInfo,
  configureGraphqlJitRuntime,
  waitForAsyncEnd,
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitCompileObject (_state, node) {
  const nestedTypeChecks = query(
    node,
    'IfStatement > LogicalExpression[operator="&&"] > UnaryExpression[operator="!"]' +
      '[argument.name="alwaysDefer"]'
  )
  const defaultResolverAssignments = query(
    node,
    'IfStatement[test.operator="&&"]:has(UnaryExpression[operator="!"][argument.name="resolver"])' +
      ':has(Identifier[name="alwaysDefer"]) AssignmentExpression[left.name="resolver"]'
  )
  const defaultResolverConditions = query(
    node,
    'IfStatement[test.operator="&&"]:has(UnaryExpression[operator="!"][argument.name="resolver"])' +
      ':has(Identifier[name="alwaysDefer"])'
  )
  const resolverConditions = query(node, 'IfStatement[test.name="resolver"]')
  const compileTypeCalls = query(node, 'CallExpression[callee.name="compileType"]')

  assert.strictEqual(
    nestedTypeChecks.length,
    1,
    'configureGraphqlJitCompileObject: nested type check not found'
  )
  assert.strictEqual(
    defaultResolverAssignments.length,
    1,
    'configureGraphqlJitCompileObject: default resolver assignment not found'
  )
  assert.strictEqual(
    defaultResolverConditions.length,
    1,
    'configureGraphqlJitCompileObject: default resolver condition not found'
  )
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

  const [nestedTypeCheck] = nestedTypeChecks
  const left = nestedTypeCheck.argument
  nestedTypeCheck.type = 'BinaryExpression'
  nestedTypeCheck.operator = '!=='
  nestedTypeCheck.left = left
  nestedTypeCheck.right = { type: 'Literal', value: true, raw: 'true' }
  delete nestedTypeCheck.prefix
  delete nestedTypeCheck.argument

  const [defaultResolverAssignment] = defaultResolverAssignments
  defaultResolverAssignment.right = parse(`(
    alwaysDefer === true
      ? (parent) => parent && parent[fieldName]
      : (parent) => parent?.[fieldName]
  )`).body[0].expression

  const [defaultResolverCondition] = defaultResolverConditions
  const [resolverCondition] = resolverConditions
  const [compileTypeCall] = compileTypeCalls
  const inlineCompileCall = clone(compileTypeCall)
  inlineCompileCall.arguments[4] = {
    type: 'ArrayExpression',
    elements: [{ type: 'Literal', value: '__ddValue' }],
  }

  const [defaultMarker] = parse(`
    const ddTraceDefault = !resolver && alwaysDefer === 'datadog'
  `).body
  // Compile the inline field only when it is used: graphql-jit compiles the subtree again for
  // the deferred path, and the discarded copy still leaves its hoisted functions behind.
  const [inlineField] = parse(`
    const ddTraceInline = ddTraceDefault
      ? context.ddTraceRuntime.compileDefaultField(
        context,
        DD_PATH,
        type,
        field,
        DD_FIELD_NODES,
        originPaths,
        DD_COMPILED
      )
      : undefined
  `).body
  replaceIdentifier(inlineField, 'DD_PATH', clone(compileTypeCall.arguments[6]))
  replaceIdentifier(inlineField, 'DD_FIELD_NODES', clone(compileTypeCall.arguments[3]))
  replaceIdentifier(inlineField, 'DD_COMPILED', inlineCompileCall)

  assert(
    insertBeforeStatement(node.body, defaultResolverCondition, [defaultMarker]),
    'configureGraphqlJitCompileObject: could not insert default marker'
  )
  assert(
    insertBeforeStatement(node.body, resolverCondition, [inlineField]),
    'configureGraphqlJitCompileObject: could not insert inline field'
  )

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

  // `true` defers defaults but also suppresses isTypeOf. A separate truthy value,
  // paired with the transformed `!== true` check, preserves both behaviors.
  node.body.body.unshift(...parse(`
    if (context.ddTraceDefaultResolvers && alwaysDefer === false) {
      alwaysDefer = 'datadog'
    }
  `).body)
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
 * @param {object} _state
 * @param {import('estree').FunctionExpression} node
 */
function configureGraphqlJitExecute (_state, node) {
  const [context] = query(node, 'VariableDeclarator[id.name="__apm$ctx"] > ObjectExpression')
  const [tracedBody] = query(
    node,
    'VariableDeclarator[id.name="__apm$traced"] > ArrowFunctionExpression > BlockStatement'
  )

  assert(context && tracedBody, 'configureGraphqlJitExecute: incomplete orchestrion wrapper')

  const properties = parse(`({
    ddDocument: document,
    ddOperationName: operationName,
    ddPlan: compilationContext.ddTraceRuntime?.getPlan(compilationContext),
    ddResolvers: compilationContext.resolvers,
    ddSchema: compilationContext.schema
  })`).body[0].expression.properties

  context.properties.push(...properties)

  tracedBody.body.unshift(...parse(`
    if (__apm$ctx.ddAborted) {
      const __apm$abortError = new Error('Aborted')
      __apm$abortError.name = 'AbortError'
      throw __apm$abortError
    }
  `).body)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitExecutionInfo (_state, node) {
  const enrichers = query(
    node,
    'MemberExpression[property.name="resolverInfoEnricher"]' +
      ':has(MemberExpression[object.name="context"][property.name="options"])'
  )

  assert.strictEqual(
    enrichers.length,
    1,
    'configureGraphqlJitExecutionInfo: resolver info enricher not found'
  )

  const replacement = parse(`
    context.ddTraceRuntime
      ? context.ddTraceRuntime.createResolverInfoEnricher(
        context,
        responsePath,
        context.options.resolverInfoEnricher
      )
      : context.options.resolverInfoEnricher
  `).body[0].expression
  const [enricher] = enrichers
  for (const key of Object.keys(enricher)) delete enricher[key]
  Object.assign(enricher, replacement)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitRuntime (_state, node) {
  const contexts = query(node, 'VariableDeclarator[id.name="executionContext"] > ObjectExpression')
  assert.strictEqual(
    contexts.length,
    1,
    'configureGraphqlJitRuntime: execution context not found'
  )

  const properties = parse(`({
    ddTrace: compilationContext.ddTraceRuntime?.startExecution(parsedVariables.coerced)
  })`).body[0].expression.properties
  contexts[0].properties.push(...properties)

  const returns = query(node, 'ReturnStatement[argument.object.name="ret"]')
  assert.strictEqual(returns.length, 1, 'configureGraphqlJitRuntime: compiled query return not found')
  assert(
    insertBeforeStatement(node.body, returns[0], parse(`
      compilationContext.ddTraceRuntime?.getPlan(compilationContext)
    `).body),
    'configureGraphqlJitRuntime: could not finalize the plan'
  )
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
