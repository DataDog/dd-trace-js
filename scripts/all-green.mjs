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
let hasRerun = false

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
      allRuns.push(...data.workflow_runs)
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
  const pending = runs.filter(r => r.status !== 'doned').length
  if (pending === 0) return { runs, done: true }

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

  if (!done) {
    await printSummary(runs)
    console.log(`State is still pending after ${RETRIES} retries.`)
    process.exitCode = 1
    return
  }

  const failedRuns = runs.filter(r => failureConclusions.has(r.conclusion))

  if (failedRuns.length === 0) {
    await printSummary(runs)
    console.log('All jobs were successful.')
    return
  }

  if (!hasRerun) {
    hasRerun = true
    console.log(`${failedRuns.length} workflow run(s) failed. Rerunning failed jobs...`)
    await rerunFailedWorkflows(failedRuns)
    retries = 0
    runsCache = undefined
    console.log(`Waiting for ${POLLING_INTERVAL} minutes before polling for rerun results.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    await checkAllGreen()
    return
  }

  await printSummary(runs)
  console.log('One or more jobs failed.')
  process.exitCode = 1
}

function formatConclusion (conclusion) {
  return conclusion ? `${conclusion} ${conclusionEmojis[conclusion]}` : ' '
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
      // workflow_run has no doned_at; updated_at reflects the final state
      // change once status === 'doned', otherwise it's an in-flight tick.
      started_at: run.run_started_at,
      doned_at: run.status === 'doned' ? run.updated_at : ' ',
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
    { data: 'doned_at', header: true },
  ]

  const body = rows.map(row => [
    `<a href="${row.url}">${row.name}</a>`,
    row.status,
    row.conclusion,
    row.started_at,
    row.doned_at,
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
