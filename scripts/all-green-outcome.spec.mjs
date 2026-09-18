import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { getAllGreenOutcome } from './all-green-outcome.mjs'

describe('All Green outcome', () => {
  it('is cancelled when a workflow was cancelled', () => {
    const runs = [
      { id: 1, conclusion: 'success' },
      { id: 2, conclusion: 'cancelled' },
    ]

    assert.strictEqual(getAllGreenOutcome(runs, new Set()), 'cancelled')
  })

  it('gives cancellation precedence over a failure', () => {
    const runs = [
      { id: 1, conclusion: 'failure' },
      { id: 2, conclusion: 'cancelled' },
    ]

    assert.strictEqual(getAllGreenOutcome(runs, new Set()), 'cancelled')
  })

  it('fails for failure and timeout conclusions', () => {
    for (const conclusion of ['failure', 'timed_out']) {
      assert.strictEqual(getAllGreenOutcome([{ id: 1, conclusion }], new Set()), 'failure')
    }
  })

  it('ignores stale failures', () => {
    const runs = [
      { id: 1, conclusion: 'failure' },
      { id: 2, conclusion: 'success' },
    ]

    assert.strictEqual(getAllGreenOutcome(runs, new Set([1])), 'success')
  })
})
