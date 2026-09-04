'use strict'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')
const { INCOMPLETE_REASON } = require('../../../../src/debugger/guardrail-metrics')
const { timeBudgetSym } = require('../../../../src/debugger/devtools_client/snapshot/symbols')

const MAX_LENGTH = 255

describe('Debugger snapshot time budget', () => {
  let processRawState
  /** @type {import('../../../../src/debugger/devtools_client/snapshot/processor').IncompleteCapture} */
  let incomplete

  beforeEach(() => {
    incomplete = { reasons: 0 }
  })

  afterEach(() => {
    assert.strictEqual(incomplete.reasons, INCOMPLETE_REASON.TIMEOUT, 'should record the timeout as incomplete reason')
  })

  before(() => {
    const loadRedaction = proxyquire.noCallThru()
    const redactionWithStub = loadRedaction('../../../../src/debugger/devtools_client/snapshot/redaction', {
      '../config': {
        dynamicInstrumentation: {
          redactedIdentifiers: [],
          redactionExcludedIdentifiers: [],
        },
      },
    })

    const processorWithStub = proxyquire('../../../../src/debugger/devtools_client/snapshot/processor', {
      './redaction': redactionWithStub,
    })

    processRawState = processorWithStub.processRawState
  })

  it('marks functions as timeout when the function value is tagged', () => {
    const raw = [{
      name: 'fn',
      value: {
        type: 'function',
        className: 'Function',
        description: 'function foo() {}',
        [timeBudgetSym]: true,
      },
    }]

    const out = processRawState(raw, MAX_LENGTH, incomplete)
    assert.deepStrictEqual(out.fn, {
      type: 'Function',
      notCapturedReason: 'timeout',
    })
  })

  it('marks objects as timeout when the object value is tagged', () => {
    const raw = [{
      name: 'obj',
      value: {
        type: 'object',
        className: 'Object',
        [timeBudgetSym]: true,
      },
    }]

    const out = processRawState(raw, MAX_LENGTH, incomplete)
    assert.deepStrictEqual(out.obj, {
      type: 'Object',
      notCapturedReason: 'timeout',
    })
  })

  it('marks arrays as timeout when the array value is tagged', () => {
    const raw = [{
      name: 'arr',
      value: {
        type: 'object',
        subtype: 'array',
        className: 'Array',
        [timeBudgetSym]: true,
      },
    }]

    const out = processRawState(raw, MAX_LENGTH, incomplete)
    assert.deepStrictEqual(out.arr, {
      type: 'Array',
      notCapturedReason: 'timeout',
    })
  })

  it('marks map entries as timeout when an entry wrapper lacks properties', () => {
    const pairs = [{
      value: {
        type: 'object',
        subtype: 'internal#entry',
        className: 'Object',
        description: 'Object',
        [timeBudgetSym]: true,
      },
    }]

    const raw = [{
      name: 'map',
      value: {
        type: 'object',
        subtype: 'map',
        className: 'Map',
        properties: pairs,
      },
    }]

    const out = processRawState(raw, MAX_LENGTH, incomplete)
    assert.deepStrictEqual(out.map, {
      type: 'Map',
      notCapturedReason: 'timeout',
    })
  })

  it('marks set entries as timeout when an entry wrapper lacks properties', () => {
    const values = [{
      value: {
        type: 'object',
        subtype: 'internal#entry',
        className: 'Object',
        description: 'Object',
        [timeBudgetSym]: true,
      },
    }]

    const raw = [{
      name: 'set',
      value: {
        type: 'object',
        subtype: 'set',
        className: 'Set',
        properties: values,
      },
    }]

    const out = processRawState(raw, MAX_LENGTH, incomplete)
    assert.deepStrictEqual(out.set, {
      type: 'Set',
      notCapturedReason: 'timeout',
    })
  })
})
