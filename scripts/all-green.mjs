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
    console.log(err)
    process.exitCode = 1
    return
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
  console.log('One or more jobs failed.')
  process.exitCode = 1
}

function formatConclusion (conclusion) {
  return conclusion ? `${conclusion} ${conclusionEmojis[conclusion]}` : ' '
}

function bySeverity (a, b) {
  return (conclusionSeverity[a.conclusion] ?? 8) - (conclusionSeverity[b.conclusion] ?? 8)
}

async function printSummary () {
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: ref,
    per_page: 100,
  })

  const runs = data.workflow_runs
    // Hide the All Green workflow itself: it's always in flight while we're
    // generating the summary, so the row is noise.
    .filter(run => run.name !== context.workflow)
    .sort(bySeverity)
    .map(run => ({
      name: run.name,
      status: run.status,
      conclusion: formatConclusion(run.conclusion),
      // workflow_run has no completed_at; updated_at reflects the final state
      // change once status === 'completed', otherwise it's an in-flight tick.
      started_at: run.run_started_at,
      completed_at: run.status === 'completed' ? run.updated_at : ' ',
      url: run.html_url,
    }))

  // console.table can't render HTML, so the raw URL goes here as its own
  // column. The GitHub Actions summary below renders the name as a link.
  console.table(runs)

  const header = [
    { data: 'workflow', header: true },
    { data: 'status', header: true },
    { data: 'conclusion', header: true },
    { data: 'started_at', header: true },
    { data: 'completed_at', header: true },
  ]

  const body = runs.map(run => [
    `<a href="${run.url}">${run.name}</a>`,
    run.status,
    run.conclusion,
    run.started_at,
    run.completed_at,
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
