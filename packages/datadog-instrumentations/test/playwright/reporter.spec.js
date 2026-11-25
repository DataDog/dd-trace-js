'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')

const Reporter = require('../../src/playwright-reporter')

describe('Playwright reporter interrupted attempts', () => {
  const summaryChannel = channel('ci:playwright:reporter:run-summary')
  let summary
  const onSummary = value => { summary = value }

  beforeEach(() => {
    summary = undefined
    summaryChannel.subscribe(onSummary)
  })

  afterEach(() => {
    summaryChannel.unsubscribe(onSummary)
  })

  for (const outcome of ['expected', 'flaky']) {
    it(`keeps a final interrupted attempt incomplete when the outcome is ${outcome}`, () => {
      const reporter = new Reporter({ captureReporterErrors: false })
      const statuses = outcome === 'flaky' ? ['failed', 'passed', 'interrupted'] : ['passed', 'interrupted']
      const test = {
        outcome: () => outcome,
        results: statuses.map(status => ({ status })),
      }
      reporter.onBegin({}, { allTests: () => [test] })
      reporter.onEnd()
      assert.deepEqual(summary, { failureCount: 0, quarantinedFailureCount: 0, hasIncompleteTests: true })
    })
  }

  it('allows an interrupted attempt that subsequently passes to finish normally', () => {
    const reporter = new Reporter({ captureReporterErrors: false })
    const test = {
      outcome: () => 'expected',
      results: [{ status: 'interrupted' }, { status: 'passed' }],
    }
    reporter.onBegin({}, { allTests: () => [test] })
    reporter.onEnd()
    assert.deepEqual(summary, { failureCount: 0, quarantinedFailureCount: 0, hasIncompleteTests: false })
  })
})
