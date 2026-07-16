'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const { inspect } = require('node:util')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

/**
 * @typedef {{ filename?: string }} ModuleParent
 * @typedef {(request: string, parent: ModuleParent | undefined, isMain: boolean) => unknown} ModuleLoad
 * @typedef {typeof import('node:module') & { _load: ModuleLoad }} LoadableModule
 */

const loadableModule = /** @type {LoadableModule} */ (Module)

// The transforms module reads `globalThis[Symbol.for('dd-trace')].graphql_*`
// at require time, so populate them before requiring the tools.
const visitor = require('graphql/language/visitor')
const printer = require('graphql/language/printer')
const ddGlobal = globalThis[Symbol.for('dd-trace')]
ddGlobal.graphql_visitor = visitor
ddGlobal.graphql_printer = printer
ddGlobal.graphql_utilities = require('graphql/utilities')

const { parse } = require('graphql')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { defaultEngineReportingSignature } = require('../../src/tools/signature')

describe('graphql signature memoization', () => {
  let visitSpy
  let printSpy

  before(() => {
    visitSpy = sinon.spy(visitor, 'visit')
    printSpy = sinon.spy(printer, 'print')
  })

  after(() => {
    visitSpy.restore()
    printSpy.restore()
  })

  it('returns the same signature without re-running visit/print for the same document and operation', () => {
    const ast = parse('query Foo($id: ID!) { user(id: $id, name: "Alice") { id name } }')

    const visitsBefore = visitSpy.callCount
    const printsBefore = printSpy.callCount
    const first = defaultEngineReportingSignature(ast, 'Foo')
    const visitsAfterFirst = visitSpy.callCount
    const printsAfterFirst = printSpy.callCount
    const second = defaultEngineReportingSignature(ast, 'Foo')
    const third = defaultEngineReportingSignature(ast, 'Foo')

    assert.notEqual(visitsAfterFirst, visitsBefore)
    assert.notEqual(printsAfterFirst, printsBefore)
    assert.equal(visitSpy.callCount, visitsAfterFirst)
    assert.equal(printSpy.callCount, printsAfterFirst)
    assert.equal(first, second)
    assert.equal(second, third)
  })

  it('treats undefined and null operationName as the same cache key', () => {
    const ast = parse('{ a b c }')

    const printsBefore = printSpy.callCount
    const first = defaultEngineReportingSignature(ast, undefined)
    const second = defaultEngineReportingSignature(ast, null)

    assert.equal(printSpy.callCount - printsBefore, 1)
    assert.equal(first, second)
  })

  it('keys the cache by operationName so different operations on the same document compute independently', () => {
    const ast = parse('query A { a } query B { b }')

    const printsBefore = printSpy.callCount
    const sigA = defaultEngineReportingSignature(ast, 'A')
    const sigB = defaultEngineReportingSignature(ast, 'B')
    defaultEngineReportingSignature(ast, 'A')
    defaultEngineReportingSignature(ast, 'B')

    assert.equal(printSpy.callCount - printsBefore, 2)
    assert.notEqual(sigA, sigB)
  })

  it('recomputes for a different document instance even if the source is identical', () => {
    const source = '{ x y }'

    const printsBefore = printSpy.callCount
    const sigA = defaultEngineReportingSignature(parse(source), undefined)
    const sigB = defaultEngineReportingSignature(parse(source), undefined)

    assert.equal(printSpy.callCount - printsBefore, 2)
    assert.equal(sigA, sigB)
  })
})

describe('graphql signature byte output', () => {
  // Pinned against the multi-pass output of `hideLiterals` + `removeAliases` +
  // `sortAST` + `printWithReducedWhitespace` from before the visitor walks
  // were collapsed; any future drift trips the assertion.
  const representative = `
    query GetUser($id: ID!, $verbose: Boolean = false) {
      aliasUser: user(id: $id, name: "Alice", limit: 100, scale: 1.5) {
        name
        id
        profile @include(if: $verbose) @customDirective(meta: "x") {
          bio
          avatar
        }
        ...UserFragment
        ... on AdminUser {
          permissions @include(if: $verbose)
        }
        friends(first: 10, filter: { active: true, names: ["a", "b"] }) {
          edges {
            node {
              name
              id
            }
          }
        }
      }
    }

    fragment UserFragment on User @include(if: $verbose) @priority {
      metadata
      tags
      createdAt
    }
  `

  const expected =
    'query GetUser($id:ID!,$verbose:Boolean=false){user(id:$id,limit:0,name:"",scale:0)' +
    '{friends(filter:{},first:0){edges{node{id name}}}id name profile' +
    '@include(if:$verbose)@customDirective(meta:""){avatar bio}...UserFragment' +
    '...on AdminUser{permissions@include(if:$verbose)}}}fragment UserFragment ' +
    'on User@include(if:$verbose)@priority{createdAt metadata tags}'

  it('matches the pre-consolidation pipeline byte-for-byte', () => {
    const ast = parse(representative)
    assert.equal(defaultEngineReportingSignature(ast, 'GetUser'), expected)
  })

  it('hides literals, drops aliases, and sorts arguments / selections / variableDefinitions', () => {
    const ast = parse('query Q($z: Int, $a: ID!) { aliased: f(b: 2, a: 1, ids: [1, 2]) { y x } }')
    assert.equal(
      defaultEngineReportingSignature(ast, 'Q'),
      'query Q($a:ID!,$z:Int){f(a:0,b:0,ids:[]){x y}}'
    )
  })

  it('keeps duplicate variable and directive sort keys stable', () => {
    const ast = parse(`
      query Q($a: Int, $a: String) {
        ...F
      }
      fragment F on Query @same(b: 2) @same(a: 1) {
        f
      }
    `)

    assert.equal(
      defaultEngineReportingSignature(ast, 'Q'),
      'query Q($a:Int,$a:String){...F}fragment F on Query@same(b:0)@same(a:0){f}'
    )
  })
})

describe('graphql signature fallback', () => {
  it('uses the tools signature when they can load', () => {
    delete require.cache[require.resolve('../../src/utils')]
    const { getSignature } = require('../../src/utils')
    const ast = parse('query Q { f(a: "value") }')

    assert.equal(getSignature(ast, 'Q', 'query'), 'query Q{f(a:"")}')
  })

  it('uses operation type and name when the tools cannot load', () => {
    const utilsPath = require.resolve('../../src/utils')
    const toolsPath = require.resolve('../../src/tools')
    const originalLoad = loadableModule._load

    delete require.cache[utilsPath]
    delete require.cache[toolsPath]
    loadableModule._load = function (request, parent, isMain) {
      if (parent?.filename === utilsPath && request === './tools') {
        throw new Error('load failed')
      }
      return originalLoad(request, parent, isMain)
    }

    try {
      const { getSignature } = require('../../src/utils')

      assert.equal(getSignature({}, 'Q', 'query'), 'query Q')
      assert.equal(getSignature({}, 'Q'), 'Q')
    } finally {
      loadableModule._load = originalLoad
      delete require.cache[utilsPath]
      delete require.cache[toolsPath]
    }
  })

  it('adds configured error extensions to span events', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const span = {
      addEvent: sinon.spy(),
    }
    const error = {
      name: 'GraphQLError',
      message: 'test',
      stack: 'stack',
      extensions: {
        code: 'E_TEST',
        retryable: true,
        detail: 42,
      },
      locations: [{ line: 1, column: 2 }],
      path: ['hello', 0],
    }

    extractErrorIntoSpanEvent({
      errorExtensions: ['code', 'retryable', 'detail', 'missing'],
    }, span, error)

    const [name, attributes] = span.addEvent.firstCall.args
    assert.equal(name, 'dd.graphql.query.error')
    assertObjectContains(attributes, {
      type: 'GraphQLError',
      message: 'test',
      stacktrace: 'stack',
      'extensions.code': 'E_TEST',
      'extensions.retryable': true,
      'extensions.detail': 42,
      locations: ['1:2'],
      path: ['hello', '0'],
    })
    assert.ok(!Object.hasOwn(attributes, 'extensions.missing'), `Available keys: ${inspect(Object.keys(attributes))}`)
  })
})

describe('extractErrorIntoSpanEvent stack handling', () => {
  const lazyStack = 'GraphQLError: lazy stack\n    at validate (graphql/validate.js:1:1)'

  /**
   * Builds a GraphQLError-shaped object with a lazy `.stack` accessor that
   * mirrors what V8 installs via `Error.captureStackTrace` in graphql-js.
   * The cost of `.stack` is paid on read, not on capture, so counting reads
   * is the strongest proof the fix avoids symbolisation.
   *
   * @param {{
   *   message?: string,
   *   locations?: ReadonlyArray<{ line: number, column: number }>,
   *   path?: ReadonlyArray<string | number>,
   *   originalError?: { stack?: string },
   * }} [shape]
   * @returns {{ error: object, getStackReads: () => number }}
   */
  function buildLazyError (shape = {}) {
    const error = { name: 'GraphQLError', message: shape.message ?? 'oops' }
    if (shape.locations !== undefined) error.locations = shape.locations
    if (shape.path !== undefined) error.path = shape.path
    if (shape.originalError !== undefined) error.originalError = shape.originalError
    let stackReads = 0
    Object.defineProperty(error, 'stack', {
      configurable: true,
      enumerable: false,
      get () {
        stackReads += 1
        return lazyStack
      },
    })
    return { error, getStackReads: () => stackReads }
  }

  function captureSpan () {
    const events = []
    return {
      events,
      addEvent (name, attributes) {
        events.push({ name, attributes })
      },
    }
  }

  it('skips stack symbolication for validation-only errors', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const { error, getStackReads } = buildLazyError({
      message: 'Cannot query field "foo" on type "Query".',
      locations: [{ line: 1, column: 3 }],
    })
    const span = captureSpan()

    extractErrorIntoSpanEvent({}, span, error)

    assert.equal(getStackReads(), 0)
    const attrs = span.events[0].attributes
    assert.ok(!Object.hasOwn(attrs, 'stacktrace'), `Available keys: ${inspect(Object.keys(attrs))}`)
  })

  it('skips stack symbolication when a validation error pins multiple AST nodes', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const { error, getStackReads } = buildLazyError({
      message: 'There can be only one operation named "Foo".',
      locations: [{ line: 2, column: 3 }, { line: 4, column: 3 }],
    })
    const span = captureSpan()

    extractErrorIntoSpanEvent({}, span, error)

    assert.equal(getStackReads(), 0)
    const attrs = span.events[0].attributes
    assert.ok(!Object.hasOwn(attrs, 'stacktrace'), `Available keys: ${inspect(Object.keys(attrs))}`)
  })

  it('keeps stacktrace for execution errors with a resolver path', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const { error } = buildLazyError({
      message: 'Resolver failed',
      locations: [{ line: 5, column: 3 }],
      path: ['user', 'name'],
    })
    const span = captureSpan()

    extractErrorIntoSpanEvent({}, span, error)

    assert.equal(span.events[0].attributes.stacktrace, lazyStack)
  })

  it('keeps stacktrace when an upstream originalError carries its own stack', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const { error } = buildLazyError({
      message: 'TypeError: cannot read properties of undefined',
      locations: [{ line: 5, column: 3 }],
      originalError: { stack: 'TypeError: ...\n    at /app/index.js:1:1' },
    })
    const span = captureSpan()

    extractErrorIntoSpanEvent({}, span, error)

    assert.equal(span.events[0].attributes.stacktrace, lazyStack)
  })

  it('keeps stacktrace for errors with neither locations nor path', () => {
    const { extractErrorIntoSpanEvent } = require('../../src/utils')
    const { error } = buildLazyError({ message: 'Something happened' })
    const span = captureSpan()

    extractErrorIntoSpanEvent({}, span, error)

    assert.equal(span.events[0].attributes.stacktrace, lazyStack)
  })
})
