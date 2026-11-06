import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { normalizeMatrixJobName } from './flakiness-job-name.mjs'

describe('flakiness job names', () => {
  it('merges trailing matrix parameters', () => {
    assert.strictEqual(
      normalizeMatrixJobName('confluentinc-kafka-javascript (24, >=1.4.0, gte.1.4.0)'),
      'confluentinc-kafka-javascript'
    )
    assert.strictEqual(
      normalizeMatrixJobName('AppSec / next (node-24, latest)'),
      'AppSec / next'
    )
    assert.strictEqual(
      normalizeMatrixJobName('Ensure Playwright Docker image (1.50.0)'),
      'Ensure Playwright Docker image'
    )
    assert.strictEqual(
      normalizeMatrixJobName('Test Optimization / integration (node-oldest, !(tia-code-coverage*))'),
      'Test Optimization / integration'
    )
  })

  it('preserves non-matrix hierarchical job names', () => {
    assert.strictEqual(normalizeMatrixJobName('AppSec / windows'), 'AppSec / windows')
    assert.strictEqual(
      normalizeMatrixJobName('main / End-to-end #6 / express4-typescript 6'),
      'main / End-to-end #6 / express4-typescript 6'
    )
  })
})
