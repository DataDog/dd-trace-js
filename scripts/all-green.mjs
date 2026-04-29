import { setTimeout } from 'timers/promises'
import { Octokit } from 'octokit'
import { summary } from '@actions/core'
import { context } from '@actions/github'

/* eslint-disable no-console */

const {
  DELAY,
  GITHUB_SHA,
  GITHUB_TOKEN,
  POLLING_INTERVAL,
  RETRIES,
} = process.env

const octokit = new Octokit({ auth: GITHUB_TOKEN })
const owner = 'DataDog'
const repo = 'dd-trace-js'
const ref = context.payload.pull_request?.head.sha || GITHUB_SHA
const params = { owner, repo, ref }
const isPullRequest = Boolean(context.payload.pull_request)

const conclusionEmojis = {
  action_required: '🔶',
  cancelled: '🚫',
  failure: '❌',
  neutral: '⚪',
  success: '✅',
  skipped: '⏭️',
  stale: '🔄',
  timed_out: '⌛',
}

const conclusionSeverity = {
  failure: 0,
  timed_out: 1,
  action_required: 2,
  cancelled: 3,
  stale: 4,
  neutral: 5,
  skipped: 6,
  success: 7,
}

const failureConclusions = new Set(['failure', 'timed_out'])

// GitHub Actions app id. Filtering server-side keeps us to a single page even
// though the unfiltered endpoint returns ~130 suites for this repo (most are
// ghost suites from internal apps installed on the org).
const githubActionsAppId = 15_368

let retries = 0
let hasRerun = false

// ETag cache for the check-suite poll. GitHub returns 304 Not Modified when
// the response is unchanged, and 304 responses don't count against the rate
// limit.
let suitesCache

async function getActiveSuites () {
  try {
    const { data, headers } = await octokit.rest.checks.listSuitesForRef({
      ...params,
      app_id: githubActionsAppId,
      per_page: 100,
      headers: suitesCache ? { 'if-none-match': suitesCache.etag } : {},
    })
    suitesCache = { etag: headers.etag, suites: data.check_suites }
    return data.check_suites
  } catch (err) {
    if (err.status === 304 && suitesCache) return suitesCache.suites
    throw err
  }
}

async function pollUntilDone () {
  const suites = await getActiveSuites()
  // The All Green workflow is itself a suite that stays non-completed while
  // this script runs, so we treat completion as "at most one pending suite".
  const pending = suites.filter(s => s.status !== 'completed').length
  if (pending <= 1) return suites

  retries++

  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

  console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
  await setTimeout(POLLING_INTERVAL * 60_000)
  console.log('Retrying.')
  return pollUntilDone()
}

async function getFailedWorkflowRuns () {
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: ref,
    per_page: 100,
  })
  return data.workflow_runs.filter(r => failureConclusions.has(r.conclusion))
}

async function rerunFailedWorkflows (workflowRuns) {
  await Promise.all(
    workflowRuns.map(workflowRun => {
      console.log(`Rerunning failed jobs for workflow run ${workflowRun.id} (${workflowRun.name}).`)
      return octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: workflowRun.id })
    })
  )
}

async function checkAllGreen () {
  let suites
  try {
    suites = await pollUntilDone()
  } catch (err) {
    await printSummary()
    throw err
  }

  const anyFailed = suites.some(s => failureConclusions.has(s.conclusion))

  if (!anyFailed) {
    await printSummary()
    console.log('All jobs were successful.')
    return
  }

  if (!hasRerun) {
    hasRerun = true
    const failedRuns = await getFailedWorkflowRuns()
    if (failedRuns.length > 0) {
      console.log(`${failedRuns.length} workflow run(s) failed. Rerunning failed jobs...`)
      await rerunFailedWorkflows(failedRuns)
      retries = 0
      suitesCache = undefined
      console.log(`Waiting for ${POLLING_INTERVAL} minutes before polling for rerun results.`)
      await setTimeout(POLLING_INTERVAL * 60_000)
      await checkAllGreen()
      return
    }
  }

  await printSummary()
  throw new Error('One or more jobs failed.')
}

async function printSummary () {
  // The summary is only useful for master pushes / scheduled runs, where it
  // surfaces in the workflow run page. PRs already have GitHub's own checks
  // UI, so we skip the paginated check-runs fetch entirely.
  if (isPullRequest) return

  const checkRuns = await octokit.paginate(
    'GET /repos/:owner/:repo/commits/:ref/check-runs',
    { ...params, per_page: 100 }
  )

  // When a check is re-run, older runs remain with their original conclusions.
  // Deduplicate by name and evaluate only the latest run for each check.
  const latestByName = new Map()
  for (const run of checkRuns) {
    const existing = latestByName.get(run.name)
    if (!existing || new Date(run.started_at) >= new Date(existing.started_at)) {
      latestByName.set(run.name, run)
    }
  }

  const runs = [...latestByName.values()]
    .sort((a, b) => (conclusionSeverity[a.conclusion] ?? 8) - (conclusionSeverity[b.conclusion] ?? 8))
    .map(run => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion
        ? `${run.conclusion} ${conclusionEmojis[run.conclusion]}`
        : ' ',
      started_at: run.started_at,
      completed_at: run.completed_at ?? ' ',
    }))

  console.table(runs)

  const header = [
    { data: 'name', header: true },
    { data: 'status', header: true },
    { data: 'conclusion', header: true },
    { data: 'started_at', header: true },
    { data: 'completed_at', header: true },
  ]

  const body = runs.map(run => [
    run.name,
    run.status,
    run.conclusion,
    run.started_at,
    run.completed_at,
  ])

  await summary
    .addHeading('Checks Summary')
    .addTable([header, ...body])
    .write()
}

console.log(`Polling status for ref: ${ref}.`)

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  await setTimeout(DELAY * 60_000)
}

await checkAllGreen()
