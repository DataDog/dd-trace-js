'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

describe('evaluator capabilities', () => {
  let evaluator
  let getOriginCapabilities
  let getRemoteConfigCapabilities

  beforeEach(() => {
    evaluator = {}
    ;({ getOriginCapabilities, getRemoteConfigCapabilities } = proxyquire(
      '../../src/openfeature/evaluator-capabilities',
      { '../../../../vendor/dist/@datadog/openfeature-node-server': evaluator }
    ))
  })

  it('does not advertise capabilities when the evaluator API is absent', () => {
    assert.deepStrictEqual(getOriginCapabilities(), { query: undefined, headers: {} })
    assert.deepStrictEqual(getRemoteConfigCapabilities(), [])
  })

  it('projects each canonical evaluator capability onto its applicable transports', () => {
    evaluator.getEvaluatorCapabilities = sinon.stub().returns(new Set([
      'unknown-v1',
      'dependent-flag-variant-key-v1',
    ]))

    assert.deepStrictEqual(getOriginCapabilities(), {
      query: { 'cap_dependent-flags-variant-key': 'v1' },
      headers: {},
    })
    assert.deepStrictEqual(getRemoteConfigCapabilities(), [1n << 50n])
  })

  for (const [description, value] of [
    ['returns the wrong type', ['dependent-flag-variant-key-v1']],
    ['throws', new Error('broken evaluator capability API')],
  ]) {
    it(`does not advertise capabilities when the evaluator API ${description}`, () => {
      evaluator.getEvaluatorCapabilities = value instanceof Error
        ? sinon.stub().throws(value)
        : sinon.stub().returns(value)

      assert.deepStrictEqual(getOriginCapabilities(), { query: undefined, headers: {} })
      assert.deepStrictEqual(getRemoteConfigCapabilities(), [])
    })
  }
})
