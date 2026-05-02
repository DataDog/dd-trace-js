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
