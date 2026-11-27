import assert from 'node:assert/strict'

import { describe, it } from 'mocha'
import sinon from 'sinon'

import { getCheckRuns, getFailedJobIds, getRestJobs } from './workflow-jobs.mjs'

const run = { id: 42, node_id: 'workflow-42', run_attempt: 1 }

/**
 * @param {object[]} nodes
 * @param {{ hasNextPage?: boolean, endCursor?: string, runAttempt?: number }} [options]
 */
function checksResponse (nodes, { hasNextPage = false, endCursor, runAttempt = 1 } = {}) {
  return {
    node: {
      runAttempt,
      checkSuite: { checkRuns: { nodes, pageInfo: { hasNextPage, endCursor } } },
    },
  }
}

describe('workflow jobs', () => {
  describe('GraphQL checks', () => {
    it('paginates latest job summaries without fetching steps', async () => {
      const check = {
        name: 'unit',
        detailsUrl: 'https://example.com/jobs/1',
        conclusion: 'SUCCESS',
        startedAt: '2026-11-09T00:00:00Z',
        completedAt: '2026-11-09T00:01:00Z',
      }
      const graphql = sinon.stub()
      graphql.onFirstCall().resolves(checksResponse([check], { hasNextPage: true, endCursor: 'next' }))
      graphql.onSecondCall().resolves(checksResponse([{ ...check, name: 'lint', conclusion: 'SKIPPED' }]))

      const jobs = await getCheckRuns({ graphql }, run)

      assert.deepStrictEqual(jobs[0], {
        name: 'unit',
        html_url: check.detailsUrl,
        conclusion: 'success',
        started_at: check.startedAt,
        completed_at: check.completedAt,
      })
      assert.strictEqual(jobs[1].conclusion, 'skipped')
      assert.strictEqual(graphql.callCount, 2)
      const [query, variables] = graphql.firstCall.args
      assert.match(query, /checkRuns\(first: 100/)
      assert.doesNotMatch(query, /\bsteps\b/)
      assert.deepStrictEqual(variables, {
        id: run.node_id,
        after: undefined,
        failedOnly: false,
        filter: { checkType: 'LATEST', conclusions: undefined },
      })
      assert.strictEqual(graphql.secondCall.args[1].after, 'next')
    })

    it('filters failures across all attempts and retains each failure occurrence', async () => {
      const graphql = sinon.stub()
      graphql.onFirstCall().resolves(checksResponse([{ databaseId: 1 }], {
        hasNextPage: true, endCursor: 'next', runAttempt: 3,
      }))
      graphql.onSecondCall().resolves(checksResponse([{ databaseId: 2 }], { runAttempt: 3 }))

      const ids = await getFailedJobIds({ graphql }, { ...run, run_attempt: 3 })

      assert.deepStrictEqual(ids, [1, 2])
      assert.deepStrictEqual(graphql.firstCall.args[1].filter, { checkType: 'ALL', conclusions: ['FAILURE'] })
      assert.strictEqual(graphql.firstCall.args[1].failedOnly, true)
      assert.match(graphql.firstCall.args[0], /startedAt @skip\(if: \$failedOnly\)/)
    })

    it('rejects failed checks without an ID for attempt verification', async () => {
      const graphql = sinon.stub().resolves(checksResponse([{}]))

      await assert.rejects(getFailedJobIds({ graphql }, run), {
        name: 'TypeError', message: 'Missing failed job ID for workflow run 42.',
      })
    })

    it('accepts an empty result and a missing optional conclusion', async () => {
      const graphql = sinon.stub()
      graphql.onFirstCall().resolves(checksResponse([]))
      graphql.onSecondCall().resolves(checksResponse([{ name: 'unit', detailsUrl: 'https://example.com/jobs/1' }]))

      assert.deepStrictEqual(await getCheckRuns({ graphql }, run), [])
      const jobs = await getCheckRuns({ graphql }, run)
      assert.strictEqual(jobs[0].conclusion, undefined)
    })

    for (const response of [{ node: null }, { node: { checkSuite: { checkRuns: { nodes: '' } } } }]) {
      it(`rejects an incomplete checks response: ${JSON.stringify(response)}`, async () => {
        const graphql = sinon.stub().resolves(response)

        await assert.rejects(getCheckRuns({ graphql }, run), {
          name: 'TypeError', message: 'Unexpected check runs response for workflow run 42.',
        })
      })
    }

    it('uses only the selected attempt when a rerun starts during summary pagination', async () => {
      const graphql = sinon.stub()
      graphql.onFirstCall().resolves(checksResponse([{ name: 'discarded' }], {
        hasNextPage: true, endCursor: 'next',
      }))
      graphql.onSecondCall().resolves(checksResponse([], { runAttempt: 2 }))
      const jobs = [{ name: 'selected attempt', html_url: 'https://example.com/jobs/1' }]
      const listJobsForWorkflowRunAttempt = sinon.stub().resolves({ data: { total_count: jobs.length, jobs } })
      const rest = { actions: { listJobsForWorkflowRunAttempt } }

      assert.deepStrictEqual(await getCheckRuns({ graphql, rest }, run), jobs)
      assert.strictEqual(graphql.callCount, 2)
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
      assert.strictEqual(listJobsForWorkflowRunAttempt.firstCall.args[0].attempt_number, 1)
    })

    it('rejects a GraphQL snapshot older than the selected attempt', async () => {
      const graphql = sinon.stub().resolves(checksResponse([], { runAttempt: 1 }))

      await assert.rejects(getCheckRuns({ graphql }, { ...run, run_attempt: 2 }), {
        message: 'Unexpected attempt for workflow run 42.',
      })
    })

    it('rejects pagination without an advancing cursor', async () => {
      const graphql = sinon.stub()
      graphql.onFirstCall().resolves(checksResponse([], { hasNextPage: true, endCursor: 'next' }))
      graphql.onSecondCall().resolves(checksResponse([], { hasNextPage: true, endCursor: 'next' }))

      await assert.rejects(getCheckRuns({ graphql }, run), {
        message: 'Missing next check runs page for workflow run 42.',
      })
      assert.strictEqual(graphql.callCount, 2)
    })

    it('propagates GraphQL errors instead of using partial data', async () => {
      const error = new Error('GraphQL resource limit exceeded')
      const graphql = sinon.stub().rejects(error)

      await assert.rejects(getCheckRuns({ graphql }, run), error)
      assert.strictEqual(graphql.callCount, 1)
    })
  })

  describe('REST jobs', () => {
    it('keeps steps and requests the exact workflow attempt', async () => {
      const jobs = [{ name: 'system', steps: [{ name: 'Run TEST scenario' }] }]
      const listJobsForWorkflowRunAttempt = sinon.stub().resolves({ data: { total_count: jobs.length, jobs } })
      const api = { rest: { actions: { listJobsForWorkflowRunAttempt } } }

      assert.deepStrictEqual(await getRestJobs(api, { ...run, run_attempt: 2 }), jobs)
      assert.deepStrictEqual(listJobsForWorkflowRunAttempt.firstCall.args[0], {
        owner: 'DataDog', repo: 'dd-trace-js', run_id: 42, attempt_number: 2, per_page: 100, page: 1,
      })
    })

    it('paginates jobs at a fixed page size', async () => {
      const jobs = Array.from({ length: 101 }, (_, id) => ({ id }))
      const listJobsForWorkflowRunAttempt = sinon.stub().callsFake(({ per_page: perPage, page }) => {
        return Promise.resolve({
          data: { total_count: jobs.length, jobs: jobs.slice((page - 1) * perPage, page * perPage) },
        })
      })

      const actual = await getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run)

      assert.deepStrictEqual(actual, jobs)
      const requests = listJobsForWorkflowRunAttempt.args.map(([options]) => [options.per_page, options.page])
      assert.deepStrictEqual(requests, [[100, 1], [100, 2]])
    })

    it('does not request another page after a full final page', async () => {
      const jobs = Array.from({ length: 100 }, (_, id) => ({ id }))
      const listJobsForWorkflowRunAttempt = sinon.stub().rejects(new Error('Unexpected request'))
      listJobsForWorkflowRunAttempt.onFirstCall().resolves({ data: { total_count: jobs.length, jobs } })

      assert.deepStrictEqual(await getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), jobs)
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
    })

    it('rejects a short final page that does not reach the reported total', async () => {
      const jobs = Array.from({ length: 100 }, (_, id) => ({ id }))
      const listJobsForWorkflowRunAttempt = sinon.stub()
      listJobsForWorkflowRunAttempt.onFirstCall().resolves({ data: { total_count: 102, jobs } })
      listJobsForWorkflowRunAttempt.onSecondCall().resolves({ data: { total_count: 102, jobs: [{ id: 100 }] } })

      await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), {
        message: 'Expected 102 jobs for workflow run 42, attempt 1, but received 101 by page 2.',
      })
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 2)
    })

    it('rejects a total that changes between pages', async () => {
      const jobs = Array.from({ length: 100 }, (_, id) => ({ id }))
      const listJobsForWorkflowRunAttempt = sinon.stub()
      listJobsForWorkflowRunAttempt.onFirstCall().resolves({ status: 200, data: { total_count: 101, jobs } })
      listJobsForWorkflowRunAttempt.onSecondCall().resolves({ status: 200, data: { total_count: 100, jobs: [] } })

      await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), {
        name: 'TypeError',
        message: 'Unexpected jobs response for workflow run 42, attempt 1, page 2, per_page 100 (HTTP 200).',
      })
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 2)
    })

    it('rejects a page with more jobs than the reported total', async () => {
      const data = { total_count: 0, jobs: [{ id: 1 }] }
      const listJobsForWorkflowRunAttempt = sinon.stub().resolves({ data })

      await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), {
        message: 'Expected 0 jobs for workflow run 42, attempt 1, but received 1 by page 1.',
      })
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
    })

    it('fails on an empty later response instead of returning partial jobs or restarting', async () => {
      const listJobsForWorkflowRunAttempt = sinon.stub()
      const jobs = Array.from({ length: 100 }, (_, id) => ({ id }))
      listJobsForWorkflowRunAttempt.onFirstCall().resolves({ data: { total_count: 101, jobs } })
      listJobsForWorkflowRunAttempt.onSecondCall().resolves({ status: 200, data: '' })

      await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), {
        name: 'TypeError',
        message: 'Unexpected jobs response for workflow run 42, attempt 1, page 2, per_page 100 (HTTP 200).',
      })
      const requests = listJobsForWorkflowRunAttempt.args.map(([options]) => [options.per_page, options.page])
      assert.deepStrictEqual(requests, [[100, 1], [100, 2]])
    })

    for (const status of [403, 502]) {
      it(`propagates HTTP ${status} without retrying or changing the page size`, async () => {
        const error = Object.assign(new Error('GitHub rejected the request'), { status })
        const listJobsForWorkflowRunAttempt = sinon.stub().rejects(error)

        await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), error)
        assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
        assert.strictEqual(listJobsForWorkflowRunAttempt.firstCall.args[0].per_page, 100)
      })
    }

    for (const data of ['', {}, { jobs: {}, total_count: 0 }, { jobs: [] }, { jobs: [], total_count: -1 }]) {
      it(`rejects malformed responses: ${JSON.stringify(data)}`, async () => {
        const listJobsForWorkflowRunAttempt = sinon.stub().resolves({ status: 200, data })

        await assert.rejects(getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), {
          name: 'TypeError',
          message: 'Unexpected jobs response for workflow run 42, attempt 1, page 1, per_page 100 (HTTP 200).',
        })
        assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
      })
    }

    it('accepts a valid empty array without retrying', async () => {
      const listJobsForWorkflowRunAttempt = sinon.stub().resolves({ data: { total_count: 0, jobs: [] } })

      assert.deepStrictEqual(await getRestJobs({ rest: { actions: { listJobsForWorkflowRunAttempt } } }, run), [])
      assert.strictEqual(listJobsForWorkflowRunAttempt.callCount, 1)
    })
  })
})
