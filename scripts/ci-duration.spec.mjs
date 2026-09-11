import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  analyzeJobs,
  classifyDuration,
  collectSnapshot,
  createMarkdownReport,
  createSlackReport,
  formatDuration,
  parseWorkflowTeams,
} from './ci-duration.mjs'

const MINUTE = 60 * 1000

/**
 * @param {number} seconds
 * @returns {string}
 */
function timestamp (seconds) {
  return new Date(seconds * 1000).toISOString()
}

/**
 * @param {{ name: string, start: number, end: number, conclusion?: string }} value
 * @returns {object}
 */
function step ({ name, start, end, conclusion = 'success' }) {
  return {
    name,
    conclusion,
    started_at: timestamp(start),
    completed_at: timestamp(end),
  }
}

/**
 * @param {{ id: number, name: string, start: number, end: number, steps?: object[] }} value
 * @returns {object}
 */
function job ({ id, name, start, end, steps = [] }) {
  return {
    id,
    name,
    html_url: `https://example.com/jobs/${id}`,
    conclusion: 'success',
    started_at: timestamp(start),
    completed_at: timestamp(end),
    steps,
  }
}

/**
 * @param {{ id: number, name: string, path: string, duration: number }} value
 * @returns {object}
 */
function run ({ id, name, path, duration }) {
  return {
    id,
    name,
    path,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: '1234567890abcdef',
    run_attempt: 1,
    run_started_at: timestamp(0),
    updated_at: timestamp(duration),
    created_at: timestamp(0),
    html_url: `https://example.com/runs/${id}`,
  }
}

describe('CI duration report', () => {
  it('uses seven minutes as the warning boundary and nine as the hard limit', () => {
    assert.strictEqual(classifyDuration(7 * MINUTE), 'healthy')
    assert.strictEqual(classifyDuration(7 * MINUTE + 1), 'warning')
    assert.strictEqual(classifyDuration(9 * MINUTE - 1), 'warning')
    assert.strictEqual(classifyDuration(9 * MINUTE), 'hard')
    assert.strictEqual(formatDuration(9 * MINUTE + 31 * 1000), '9m31s')
  })

  it('gets specialist workflow teams from CODEOWNERS', () => {
    const codeowners = `
/.github/workflows/*.yml @DataDog/dd-trace-js @DataDog/lang-platform-js @dd-octo-sts
/.github/workflows/appsec.yml @DataDog/dd-trace-js @DataDog/asm-js @dd-octo-sts
/.github/workflows/serverless.yml @DataDog/serverless-aws @DataDog/apm-serverless
`
    const result = parseWorkflowTeams(codeowners)

    assert.strictEqual(result.defaultTeam, 'lang-platform-js')
    assert.strictEqual(result.teams.get('.github/workflows/appsec.yml'), 'asm-js')
    assert.strictEqual(result.teams.get('.github/workflows/serverless.yml'), 'serverless-aws, apm-serverless')
  })

  it('ranks unique scenarios across every system-test job', () => {
    const result = analyzeJobs([
      job({
        id: 1,
        name: 'End-to-end #9 / express4',
        start: 0,
        end: 756,
        steps: [
          step({ name: 'Run FAST scenario', start: 1, end: 31 }),
          step({ name: 'Run FEATURE_FLAGS scenario', start: 31, end: 602 }),
        ],
      }),
      job({
        id: 2,
        name: 'End-to-end #4 / express5',
        start: 0,
        end: 700,
        steps: [
          step({ name: 'Run APPSEC_RASP scenario', start: 5, end: 477 }),
          step({ name: 'Run FEATURE_FLAGS scenario', start: 477, end: 677 }),
        ],
      }),
      job({
        id: 3,
        name: 'End-to-end #12 / express4-typescript',
        start: 0,
        end: 650,
        steps: [
          step({ name: 'Run DEBUGGER_REPLAY scenario', start: 5, end: 409 }),
          step({ name: 'Run UNUSED scenario', start: 409, end: 409, conclusion: 'skipped' }),
        ],
      }),
    ])

    assert.deepStrictEqual(result.jobs.map(value => value.id), [1, 2, 3])
    assert.deepStrictEqual(result.scenarios.map(value => value.name), [
      'FEATURE_FLAGS',
      'APPSEC_RASP',
      'DEBUGGER_REPLAY',
      'FAST',
    ])
    assert.strictEqual(result.scenarios[0].jobName, 'End-to-end #9 / express4')
    assert.strictEqual(result.scenarios[0].durationMs, 571 * 1000)
  })

  it('fetches jobs only for workflows over the warning threshold', async () => {
    const anchor = {
      ...run({ id: 1, name: 'All Green', path: '.github/workflows/all-green.yml', duration: 60 }),
      created_at: '2026-09-10T12:00:00.000Z',
      updated_at: '2026-09-10T12:00:00.000Z',
    }
    const olderAnchor = {
      ...anchor,
      id: 0,
      head_sha: 'older1234567890',
      created_at: '2026-09-09T12:00:00.000Z',
    }
    const systemTests = run({
      id: 2,
      name: 'System Tests',
      path: '.github/workflows/system-tests.yml',
      duration: 601,
    })
    const appsec = run({ id: 3, name: 'AppSec', path: '.github/workflows/appsec.yml', duration: 420 })
    const jobRequests = []
    const api = {
      actions: {
        listWorkflowRuns: options => {
          assert.strictEqual(options.per_page, 10)
          assert.strictEqual(options.workflow_id, 'all-green.yml')
          assert.deepStrictEqual(options.headers, { 'cache-control': 'no-cache' })
          return Promise.resolve({ data: { workflow_runs: [olderAnchor, anchor] } })
        },
        listWorkflowRunsForRepo: options => {
          assert.strictEqual(options.head_sha, anchor.head_sha)
          assert.strictEqual(options.branch, 'master')
          return Promise.resolve({ data: { workflow_runs: [anchor, systemTests, appsec] } })
        },
        listJobsForWorkflowRunAttempt: options => {
          jobRequests.push(options.run_id)
          return Promise.resolve({ data: { jobs: [job({ id: 4, name: 'slow', start: 0, end: 590 })] } })
        },
      },
    }
    const codeowners = '/.github/workflows/appsec.yml @DataDog/dd-trace-js @DataDog/asm-js\n'
    const snapshot = await collectSnapshot(api, codeowners, new Date('2026-09-10T13:00:00.000Z'))

    assert.deepStrictEqual(jobRequests, [2])
    assert.deepStrictEqual(snapshot.workflows.map(workflow => workflow.name), ['System Tests', 'AppSec'])
    assert.strictEqual(snapshot.workflows[0].team, 'multiple teams')
    assert.strictEqual(snapshot.workflows[1].team, 'asm-js')
  })

  it('uses the original run creation time for the stale warning', async () => {
    const anchor = {
      ...run({ id: 1, name: 'All Green', path: '.github/workflows/all-green.yml', duration: 60 }),
      created_at: '2026-09-01T12:00:00.000Z',
      updated_at: '2026-09-08T11:59:00.000Z',
    }
    const api = {
      actions: {
        listWorkflowRuns: () => Promise.resolve({ data: { workflow_runs: [anchor] } }),
        listWorkflowRunsForRepo: () => Promise.resolve({ data: { workflow_runs: [anchor] } }),
      },
    }
    const boundary = await collectSnapshot(api, '', new Date('2026-09-08T12:00:00.000Z'))
    const stale = await collectSnapshot(api, '', new Date('2026-09-08T12:00:00.001Z'))

    assert.strictEqual(boundary.stale, false)
    assert.strictEqual(stale.stale, true)
  })

  it('keeps Slack compact and puts full detail in Markdown', () => {
    const anchor = {
      ...run({ id: 1, name: 'All Green', path: '.github/workflows/all-green.yml', duration: 60 }),
      updated_at: '2026-09-10T12:00:00.000Z',
    }
    const jobs = analyzeJobs([
      job({
        id: 4,
        name: 'End-to-end #9 / express4',
        start: 0,
        end: 756,
        steps: [step({ name: 'Run FEATURE_FLAGS scenario', start: 31, end: 602 })],
      }),
    ])
    const snapshot = {
      anchor,
      stale: false,
      workflows: [{
        ...run({ id: 2, name: 'System Tests', path: '.github/workflows/system-tests.yml', duration: 823 }),
        durationMs: 823 * 1000,
        team: 'multiple teams',
        analysis: jobs,
      }],
    }

    const slack = createSlackReport(snapshot, 'https://example.com/report')
    const markdown = createMarkdownReport(snapshot)

    assert.match(slack, /1 workflow exceeded 7m; 1 reached the 9m hard limit/)
    assert.match(slack, /Slowest job:/)
    assert.match(slack, /Slowest scenarios across the matrix/)
    assert.match(slack, /FEATURE_FLAGS/)
    assert.match(slack, /View the full GitHub report/)
    assert.doesNotMatch(slack, /multiple teams/)
    assert.ok(slack.length < 3000)
    assert.match(markdown, /Workflow durations/)
    assert.match(markdown, /Slowest unique scenarios across the matrix/)
    assert.match(markdown, /76%/)
  })
})
