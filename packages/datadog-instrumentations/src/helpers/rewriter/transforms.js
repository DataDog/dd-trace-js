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

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])
const identifierPattern = /^[$A-Z_a-z][$\w]*$/

module.exports = {
  awaitContextCallback,
  configureGraphqlJitCompileObject,
  configureGraphqlJitDeferredField,
  configureGraphqlJitExecute,
  configureGraphqlJitRuntime,
  configureMercuriusRequest,
  waitForAsyncEnd,
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
 *     callbackName?: string
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

  const { callbackArgumentNames = [], callbackName } = state.transformOptions ?? {}

  assert(identifierPattern.test(callbackName), 'awaitContextCallback: callbackName must be an identifier')
  assert(callbackArgumentNames.every(name => identifierPattern.test(name)),
    'awaitContextCallback: callbackArgumentNames must be identifiers')

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

  assert(enclosingFunction?.async, 'awaitContextCallback: expected an enclosing async function')
  assert(hasTraceWrapper, 'awaitContextCallback: expected an enclosing trace wrapper')

  const callbackVariable = `__apm$${callbackName}`
  if (query(node, `[id.name="${callbackVariable}"]`).length > 0) {
    return
  }

  const originalStatements = node.consequent.body
  const callbackStatements = parse(`
    async function wrapper () {
      const ${callbackVariable} = __apm$ctx.${callbackName};
      if (typeof ${callbackVariable} === 'function') {
        try {
          await ${callbackVariable}(${callbackArgumentNames.join(', ')});
        } catch {}
        if (true) {}
      } else {
      }
    }
  `).body[0].body.body

  const callbackBranch = callbackStatements[1]
  const recheckedBranch = callbackBranch.consequent.body[1]
  recheckedBranch.test = clone(node.test)
  recheckedBranch.consequent.body.push(...clone(originalStatements))
  recheckedBranch.alternate = clone(node.alternate)
  callbackBranch.alternate.body.push(...originalStatements)
  node.consequent.body = callbackStatements
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
 * @param {import('estree').FunctionExpression} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 */
function configureGraphqlJitExecute (_state, node, _parent, ancestry) {
  const context = queryOne(node, 'VariableDeclarator[id.name="__apm$ctx"] > ObjectExpression')
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
  const activeCall = queryOne(
    node,
    'AssignmentExpression[left.object.name="__apm$ctx"][left.property.name="result"] > ' +
      'CallExpression[callee.name="__apm$traced"]'
  )
  assert(wrapped.init, 'configureGraphqlJitExecute: wrapped query has no implementation')

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
    insertBeforeStatement(createBoundQuery.body, retDeclaration, [...bindings, wrappedDeclaration]),
    'configureGraphqlJitExecute: could not hoist original query'
  )

  const fastCall = subscriberGuard.consequent.argument
  fastCall.callee = parse('__apm$wrapped.apply').body[0].expression
  fastCall.arguments = parse('call(this, arguments)').body[0].expression.arguments
  subscriberGuard.consequent = { type: 'BlockStatement', body: [subscriberGuard.consequent] }
  activeCall.callee = parse('__apm$wrapped.apply').body[0].expression
  activeCall.arguments = parse('call(this, __apm$arguments)').body[0].expression.arguments

  const statements = node.body.body
  const subscriberGuardIndex = statements.indexOf(subscriberGuard)
  const tracedDeclarationIndex = statements.indexOf(tracedDeclaration)
  assert.notStrictEqual(subscriberGuardIndex, -1, 'configureGraphqlJitExecute: subscriber guard is not top-level')
  assert.notStrictEqual(tracedDeclarationIndex, -1, 'configureGraphqlJitExecute: traced declaration is not top-level')
  statements.splice(subscriberGuardIndex, 1)
  statements.splice(statements.indexOf(tracedDeclaration), 1)
  statements.unshift(subscriberGuard)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitDeferredField (_state, node) {
  const declarations = query(node, 'VariableDeclaration:has(VariableDeclarator[id.name="resolverCall"])')
  const resolverCalls = query(node, 'VariableDeclarator[id.name="resolverCall"]')
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

  const [descriptor] = parse(`
    const ddTraceDescriptorId = context.ddTraceRuntime?.registerField(context, responsePath, {
      fieldName,
      fieldNodes,
      returnType: fieldType,
      parentType
    })
  `).body
  assert(
    insertBeforeStatement(node.body, declarations[0], [descriptor]),
    'configureGraphqlJitDeferredField: could not insert descriptor'
  )

  const [resolverCall] = resolverCalls
  const replacement = parse(`
    DD_CALL.slice(0, -1) +
      (ddTraceDescriptorId === undefined ? '' : ', ' + ddTraceDescriptorId) +
      ')'
  `).body[0].expression
  replaceIdentifier(replacement, 'DD_CALL', resolverCall.init)
  resolverCall.init = replacement
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
