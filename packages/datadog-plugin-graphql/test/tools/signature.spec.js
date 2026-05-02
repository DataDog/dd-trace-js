'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

// The transforms module reads `globalThis[Symbol.for('dd-trace')].graphql_*`
// at require time, so populate them before requiring the tools.
const visitor = require('graphql/language/visitor')
const printer = require('graphql/language/printer')
const ddGlobal = globalThis[Symbol.for('dd-trace')]
ddGlobal.graphql_visitor = visitor
ddGlobal.graphql_printer = printer
ddGlobal.graphql_utilities = require('graphql/utilities')

const { parse } = require('graphql')
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
    const ast = parse('query Q($z: Int, $a: ID!) { aliased: f(b: 2, a: 1) { y x } }')
    assert.equal(
      defaultEngineReportingSignature(ast, 'Q'),
      'query Q($a:ID!,$z:Int){f(a:0,b:0){x y}}'
    )
  })
})
