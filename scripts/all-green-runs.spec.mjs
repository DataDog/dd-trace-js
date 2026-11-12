import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  hasPendingWorkflowRuns,
  markWorkflowRunsForRetry,
  mergeWorkflowRuns,
} from './all-green-runs.mjs'

describe('All Green workflow runs', () => {
  it('preserves runs omitted from a later response', () => {
    const previous = [
      { id: 1, status: 'completed' },
      { id: 2, status: 'in_progress' },
    ]

    assert.deepStrictEqual(mergeWorkflowRuns(previous, [previous[0]]), previous)
    assert.deepStrictEqual(mergeWorkflowRuns(previous, []), previous)
  })

  it('updates previously observed runs', () => {
    const previous = [{ id: 1, status: 'in_progress' }]
    const completed = { id: 1, status: 'completed' }

    assert.deepStrictEqual(mergeWorkflowRuns(previous, [completed]), [completed])
  })

  it('ignores snapshots from an earlier retry attempt', () => {
    const retry = { id: 1, status: 'queued', conclusion: null, run_attempt: 2 }
    const stale = { id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1 }

    assert.deepStrictEqual(mergeWorkflowRuns([retry], [stale]), [retry])
  })

  it('adds newly observed runs', () => {
    const previous = [{ id: 1, status: 'completed' }]
    const added = { id: 2, status: 'queued' }

    assert.deepStrictEqual(mergeWorkflowRuns(previous, [added]), [...previous, added])
  })

  it('treats an empty response as pending', () => {
    assert.strictEqual(hasPendingWorkflowRuns([]), true)
    assert.strictEqual(hasPendingWorkflowRuns([{ status: 'queued' }]), true)
    assert.strictEqual(hasPendingWorkflowRuns([{ status: 'completed' }]), false)
  })

  it('marks retried runs as the next pending attempt', () => {
    const completed = { id: 1, status: 'completed', conclusion: 'failure', run_attempt: 1 }
    const unchanged = { id: 2, status: 'completed', conclusion: 'success', run_attempt: 1 }

    assert.deepStrictEqual(markWorkflowRunsForRetry([completed, unchanged], new Set([1])), [
      { id: 1, status: 'queued', conclusion: null, run_attempt: 2 },
      unchanged,
    ])
  })
})
