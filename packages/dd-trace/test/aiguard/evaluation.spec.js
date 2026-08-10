'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  createEvaluationOutcome,
  parseEvaluationResponse,
  shouldBlockEvaluation,
} = require('../../src/aiguard/evaluation')

describe('AI Guard evaluation response', () => {
  it('parses the backend response into the internal evaluation contract', () => {
    const sdsFindings = [{ category: 'ssn' }]
    const tagProbabilities = { jailbreak: 0.8 }
    const response = {
      data: {
        attributes: {
          action: 'DENY',
          reason: 'Sensitive data detected.',
          tags: ['jailbreak'],
          sds_findings: sdsFindings,
          tag_probs: tagProbabilities,
          is_blocking_enabled: true,
        },
      },
    }

    assert.deepStrictEqual(parseEvaluationResponse(response), {
      action: 'DENY',
      reason: 'Sensitive data detected.',
      tags: ['jailbreak'],
      sdsFindings,
      tagProbabilities,
      hasTagProbabilities: true,
      blockingEnabled: true,
    })
  })

  it('uses safe defaults for optional backend fields', () => {
    assert.deepStrictEqual(parseEvaluationResponse({ data: { attributes: { action: 'ALLOW' } } }), {
      action: 'ALLOW',
      reason: undefined,
      tags: [],
      sdsFindings: [],
      tagProbabilities: {},
      hasTagProbabilities: false,
      blockingEnabled: false,
    })
  })

  for (const response of [
    undefined,
    {},
    { data: {} },
    { data: { attributes: {} } },
    { data: { attributes: { action: '' } } },
    { data: { attributes: { action: 42 } } },
  ]) {
    it('rejects an invalid backend response', () => {
      assert.strictEqual(parseEvaluationResponse(response), undefined)
    })
  }

  it('creates a blocked outcome', () => {
    const evaluation = parseEvaluationResponse({
      data: {
        attributes: {
          action: 'DENY',
          reason: 'Sensitive data detected.',
          tags: ['prompt-injection'],
          sds_findings: [{ category: 'email_address' }],
          tag_probs: { 'prompt-injection': 0.9 },
          is_blocking_enabled: true,
        },
      },
    })

    assert.ok(evaluation)
    const outcome = createEvaluationOutcome(evaluation, true)

    assert.deepStrictEqual(outcome, {
      result: {
        action: 'DENY',
        reason: 'Sensitive data detected.',
        tags: ['prompt-injection'],
        tagProbabilities: { 'prompt-injection': 0.9 },
        sds: [{ category: 'email_address' }],
      },
      shouldBlock: true,
      hasTagProbabilities: true,
    })
  })

  for (const testCase of [
    { block: false, action: 'DENY', blockingEnabled: true, expected: false },
    { block: true, action: 'DENY', blockingEnabled: false, expected: false },
    { block: true, action: 'ALLOW', blockingEnabled: true, expected: false },
    { block: true, action: 'DENY', blockingEnabled: true, expected: true },
  ]) {
    it(`returns ${testCase.expected} when block=${testCase.block}, action=${testCase.action}, and ` +
      `blockingEnabled=${testCase.blockingEnabled}`, () => {
      const evaluation = {
        action: testCase.action,
        blockingEnabled: testCase.blockingEnabled,
      }

      assert.strictEqual(shouldBlockEvaluation(testCase.block, evaluation), testCase.expected)
    })
  }
})
