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

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  throttle: {
    onRateLimit: () => {
      console.error('GitHub API rate limit reached, failing immediately.')
      return false
    },
    onSecondaryRateLimit: () => {
      console.error('GitHub API secondary rate limit reached, failing immediately.')
      return false
    },
  },
})
const owner = 'DataDog'
const repo = 'dd-trace-js'
const ref = context.payload.pull_request?.head.sha || GITHUB_SHA

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

let retries = 0
const retriedRunIds = new Set()

// ETag cache for the workflow-runs poll. GitHub returns 304 Not Modified when
// the response is unchanged, and 304 responses don't count against the rate
// limit. workflow_runs are sorted newest first, so an unchanged first page is
// a reliable proxy for "no changes since last poll".
let runsCache

async function getRuns () {
  try {
    const allRuns = []
    let etag
    for await (const { data, headers } of octokit.paginate.iterator(
      octokit.rest.actions.listWorkflowRunsForRepo,
      {
        owner,
        repo,
        head_sha: ref,
        per_page: 100,
        headers: runsCache ? { 'if-none-match': runsCache.etag } : {},
      }
    )) {
      etag ??= headers.etag
      allRuns.push(...data)
    }
    // Isolate per trigger so a parallel all-green run on the same SHA doesn't
    // see our runs (and we don't see theirs). Filter by event, by PR number
    // when on a PR (handles two PRs sharing the same head commit), and drop
    // our own All Green run since it stays in_progress while we poll.
    const myPR = context.payload.pull_request?.number
    const filtered = allRuns.filter(r =>
      r.name !== context.workflow &&
      r.event === context.eventName &&
      (myPR == null || r.pull_requests?.some(pr => pr.number === myPR))
    )
    runsCache = { etag, runs: filtered }
    return filtered
  } catch (err) {
    if (err.status === 304 && runsCache) return runsCache.runs
    throw err
  }
}

async function pollUntilDone () {
  const runs = await getRuns()

  // Check before modifying retriedRunIds to avoid false positives on freshly requeued runs.
  const retryFailed = runs.filter(r =>
    r.status === 'completed' &&
    failureConclusions.has(r.conclusion) &&
    retriedRunIds.has(r.id)
  )

  if (retryFailed.length > 0) {
    for (const run of retryFailed) {
      console.error(`Workflow run ${run.id} (${run.name}) failed after retry, failing immediately.`)
    }
    return { runs, done: true }
  }

  const toRetry = runs.filter(r =>
    r.status === 'completed' &&
    failureConclusions.has(r.conclusion) &&
    !retriedRunIds.has(r.id)
  )

  if (toRetry.length > 0) {
    await rerunFailedWorkflows(toRetry)
    for (const run of toRetry) retriedRunIds.add(run.id)
    runsCache = undefined
  }

  const pending = runs.filter(r => r.status !== 'completed').length
  if (pending === 0 && toRetry.length === 0) return { runs, done: true }

  retries++

  if (RETRIES && retries > RETRIES) return { runs, done: false }

  console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
  await setTimeout(POLLING_INTERVAL * 60_000)
  console.log('Retrying.')
  return pollUntilDone()
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
  const { runs, done } = await pollUntilDone()

  await printSummary(runs)

  if (!done) {
    console.log(`State is still pending after ${RETRIES} retries.`)
    process.exitCode = 1
    return
  }

  const failedRuns = runs.filter(r => failureConclusions.has(r.conclusion))

  if (failedRuns.length === 0) {
    console.log('All jobs were successful.')
  } else {
    console.log('One or more jobs failed.')
    process.exitCode = 1
  }
}

function formatConclusion (conclusion) {
  return conclusion ? `${conclusion} ${conclusionEmojis[conclusion]}` : ' '
}

function formatTime (timestamp) {
  if (!timestamp) return ' '
  const date = new Date(timestamp)
  return date.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
}

function formatDuration (startedAt, completedAt) {
  if (!startedAt || !completedAt) return ' '
  const start = new Date(startedAt)
  const end = new Date(completedAt)
  const seconds = Math.floor((end - start) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function bySeverity (a, b) {
  return (conclusionSeverity[a.conclusion] ?? 8) - (conclusionSeverity[b.conclusion] ?? 8)
}

async function printSummary (runs) {
  const rows = runs
    .sort(bySeverity)
    .map(run => ({
      name: run.name,
      status: run.status,
      conclusion: formatConclusion(run.conclusion),
      // workflow_run has no completed_at; updated_at reflects the final state
      // change once status === 'completed', otherwise it's an in-flight tick.
      started_at: formatTime(run.run_started_at),
      completed_at: formatTime(run.status === 'completed' ? run.updated_at : null),
      duration: formatDuration(run.run_started_at, run.status === 'completed' ? run.updated_at : null),
      url: run.html_url,
    }))

  // console.table can't render HTML, so the raw URL goes here as its own
  // column. The GitHub Actions summary below renders the name as a link.
  console.table(rows)

  const header = [
    { data: 'workflow', header: true },
    { data: 'status', header: true },
    { data: 'conclusion', header: true },
    { data: 'started_at', header: true },
    { data: 'completed_at', header: true },
    { data: 'duration', header: true },
  ]

  const body = rows.map(row => [
    `<a href="${row.url}">${row.name}</a>`,
    row.status,
    row.conclusion,
    row.started_at,
    row.completed_at,
    row.duration,
  ])

  await summary
    .addHeading('Workflows Summary')
    .addTable([header, ...body])
    .write()
}

console.log(`Polling status for ref: ${ref}.`)

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  await setTimeout(DELAY * 60_000)
}

await checkAllGreen()
