import assert from 'node:assert/strict'

import { afterEach, beforeEach, describe, it } from 'mocha'
import nock from 'nock'
import sinon from 'sinon'

function mockRuns () {
  const workflow = 'APM Integrations'
  return nock('https://api.github.com')
    .get(/\/actions\/workflows\/[^/]+\/runs/)
    .query(true)
    .times(11)
    .reply(200, uri => {
      const url = new URL(uri, 'https://api.github.com')
      assert.strictEqual(url.searchParams.get('created'), '2026-11-09..2026-11-09')
      assert.strictEqual(url.searchParams.get('status'), 'success')
      if (!url.pathname.includes('apm-integrations.yml')) return { workflow_runs: [] }
      return {
        workflow_runs: [
          { id: 1, node_id: 'first', name: workflow, run_attempt: 1 },
          { id: 2, node_id: 'rerun', name: workflow, run_attempt: 3 },
        ],
      }
    })
}

describe('flakiness report', () => {
  let log

  beforeEach(() => {
    sinon.stub(process, 'env').value({
      ...process.env,
      CI: '',
      GITHUB_TOKEN: 'test-token',
      UNTIL: '2026-11-09',
      DAYS: '1',
      BRANCH: 'master',
      MERGE: 'true',
      OCCURRENCES: '2',
    })
    log = sinon.stub(console, 'log')
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
    sinon.restore()
  })

  it('preserves historical failures when another attempt starts during collection', async () => {
    const runs = mockRuns()
    const requests = []
    const checks = nock('https://api.github.com')
      .post('/graphql')
      .twice()
      .reply(200, (uri, body) => {
        const { query, variables } = body
        requests.push(query)
        assert.doesNotMatch(query, /\bsteps\b/)
        assert.strictEqual(variables.id, 'rerun')
        assert.deepStrictEqual(variables.filter, { checkType: 'ALL', conclusions: ['FAILURE'] })
        const secondPage = variables.after === 'next'
        const nodes = secondPage ? [{ databaseId: 2 }, { databaseId: 3 }, { databaseId: 4 }] : [{ databaseId: 1 }]
        return {
          data: {
            node: {
              runAttempt: secondPage ? 4 : 3,
              checkSuite: {
                checkRuns: {
                  nodes,
                  pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : 'next' },
                },
              },
            },
          },
        }
      })
    const attempts = nock('https://api.github.com')
    const jobs = ['http (24)', 'http (26)', 'allowed failure', 'later failure']
    for (const [index, name] of jobs.entries()) {
      const id = index + 1
      attempts.get(`/repos/DataDog/dd-trace-js/actions/jobs/${id}`).reply(200, {
        run_attempt: id,
        workflow_name: id === 1 ? null : 'APM Integrations',
        name,
        html_url: `https://example.com/jobs/${id}`,
      })
    }

    await import('./flakiness.mjs?success')

    runs.done()
    checks.done()
    attempts.done()
    assert.strictEqual(requests.length, 2)
    assert.ok(requests[0].includes('name @skip(if: $failedOnly)'))
    assert.ok(requests[0].includes('detailsUrl @skip(if: $failedOnly)'))
    const markdown = log.firstCall.args[0]
    assert.match(markdown, /\* APM Integrations\n {4}\* http /)
    assert.match(markdown, /\[01\]\(https:\/\/example.com\/jobs\/1\)/)
    assert.match(markdown, /\[02\]\(https:\/\/example.com\/jobs\/2\)/)
    assert.doesNotMatch(markdown, /allowed failure|later failure|example.com\/jobs\/[34]/)
    assert.match(markdown, /\* Total runs: 2\n\* Flaky runs: 1\n\* Workflow success rate: 50%/)
  })

  it('fails instead of dropping a failure whose attempt could not be verified', async () => {
    const runs = mockRuns()
    const checks = nock('https://api.github.com')
      .post('/graphql')
      .reply(200, {
        data: {
          node: {
            runAttempt: 3,
            checkSuite: {
              checkRuns: {
                nodes: [{ databaseId: 1, name: 'http', detailsUrl: 'https://example.com/jobs/1' }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      })
    const attempt = nock('https://api.github.com')
      .get('/repos/DataDog/dd-trace-js/actions/jobs/1').reply(200, {})

    await assert.rejects(import('./flakiness.mjs?missing-attempt'), {
      name: 'TypeError', message: 'Missing attempt for workflow job 1.',
    })

    runs.done()
    checks.done()
    attempt.done()
    assert.strictEqual(log.callCount, 0)
  })

  it('fails the report when GraphQL returns errors with partial data', async () => {
    const runs = mockRuns()
    const checks = nock('https://api.github.com')
      .post('/graphql')
      .reply(200, {
        data: { node: null },
        errors: [{ message: 'Unavailable check data' }],
      })

    await assert.rejects(import('./flakiness.mjs?partial-data'), /Unavailable check data/)

    runs.done()
    checks.done()
    assert.strictEqual(log.callCount, 0)
  })
})
