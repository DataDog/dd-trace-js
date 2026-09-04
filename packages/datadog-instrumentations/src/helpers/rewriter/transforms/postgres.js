'use strict'

const assert = require('node:assert')

const { parse, query } = require('../compiler')

const POSTGRES_OPTIONS = '__ddTracePostgresOptions'
const POSTGRES_QUERY_REGISTRY = '__ddTracePostgresQueries'
const POSTGRES_QUERY_REGISTRY_SYMBOL = '__ddTracePostgresQueriesSymbol'
const POSTGRES_READY = '__ddTracePostgresQueryReady'
const POSTGRES_STATEMENT = 'this.string ?? (this.tagged && this.strings?.length !== 1 ? undefined : this.strings?.[0])'

module.exports = {
  postgresQueryHandlers,
  postgresQueryLifecycle,
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
