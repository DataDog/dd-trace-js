import { setTimeout } from 'timers/promises'
import { Octokit } from 'octokit'
import { summary } from '@actions/core'
import { context } from '@actions/github'
import { downloadArtifacts } from './download-artifacts.mjs'
import { logUploads } from './run-upload.mjs'
import { uploadJunit } from './upload-junit.mjs'
import { uploadCoverage, sendCodecovNotifications } from './upload-coverage.mjs'

/* eslint-disable no-console */

const {
  BASE_REF,
  DELAY,
  GITHUB_EVENT_NAME,
  GITHUB_SHA,
  GITHUB_TOKEN,
  HEAD_BRANCH,
  HEAD_SHA,
  POLLING_INTERVAL,
  PR_NUMBER,
  RETRIES,
  RUN_ATTEMPT,
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

const failureConclusions = new Set(['failure', 'timed_out', 'cancelled'])
const pollingRetryConclusions = new Set(['failure', 'timed_out'])

let retries = 0
const retriedRunIds = new Set()
// Runs where reRunWorkflowFailedJobs returned 403 — GitHub says no failed jobs
// exist, meaning the run's failure conclusion is stale (e.g. a job that failed
// due to a GitHub infrastructure error auto-recovered). Treat them as passed.
const staleFailureRunIds = new Set()

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

// Runs whose reports have already been downloaded/merged/uploaded, and the resulting promises —
// each sibling workflow's coverage and junit reports go out as soon as that workflow reaches a
// final state, instead of waiting for every workflow to finish before downloading or uploading
// anything, so a fast workflow's reports land while slower ones are still running.
const processedRunIds = new Set()
const processingPromises = []

/**
 * Download, merge, and upload a single finished workflow run's junit and coverage reports.
 *
 * @param {{ id: number, name: string }} run
 * @returns {Promise<void>}
 */
async function processRun (run) {
  const { downloaded, failed } = await downloadArtifacts(octokit, { owner, repo, token: GITHUB_TOKEN, runs: [run] })

  const [junitResults, coverageResults] = await Promise.all([
    uploadJunit(run),
    uploadCoverage(run, {
      sha: HEAD_SHA,
      branch: HEAD_BRANCH,
      prNumber: PR_NUMBER,
      eventName: GITHUB_EVENT_NAME,
      baseRef: BASE_REF,
    }),
  ])
  const downloadSummary = failed > 0 ? `${downloaded} artifact(s), ${failed} failed` : `${downloaded} artifact(s)`
  logUploads(`${run.name} (${downloadSummary})`, [...junitResults, ...coverageResults])
}

/**
 * Kick off processing for any run that just reached a final state and hasn't been processed yet.
 * A run is final once it's completed and either isn't retried (its conclusion isn't in
 * `pollingRetryConclusions`) or already went through a retry attempt.
 *
 * @param {Array<{ id: number, name: string, status: string, conclusion: string }>} runs
 */
function scheduleProcessing (runs) {
  if (!process.env.GITHUB_ACTIONS) return

  const settled = runs.filter(r =>
    r.status === 'completed' &&
    (!pollingRetryConclusions.has(r.conclusion) || retriedRunIds.has(r.id)) &&
    !processedRunIds.has(r.id)
  )

  for (const run of settled) {
    processedRunIds.add(run.id)
    processingPromises.push(
      processRun(run).catch(err => {
        console.error(`Failed to process workflow run ${run.id} (${run.name}): ${err.message}`)
        process.exitCode = 1
      })
    )
  }
}

async function pollUntilDone () {
  const runs = await getRuns()

  scheduleProcessing(runs)

  // Check before modifying retriedRunIds to avoid false positives on freshly requeued runs.
  const retryFailed = runs.filter(r =>
    r.status === 'completed' &&
    failureConclusions.has(r.conclusion) &&
    retriedRunIds.has(r.id) &&
    !staleFailureRunIds.has(r.id)
  )

  if (retryFailed.length > 0) {
    for (const run of retryFailed) {
      console.error(`Workflow run ${run.id} (${run.name}) failed after retry, failing immediately.`)
    }
    return { runs, done: true }
  }

  const toRetry = runs.filter(r =>
    r.status === 'completed' &&
    pollingRetryConclusions.has(r.conclusion) &&
    !retriedRunIds.has(r.id)
  )

  const pending = runs.filter(r => r.status !== 'completed').length
  if (pending === 0 && toRetry.length === 0) return { runs, done: true }

  retries++

  if (RETRIES && retries > RETRIES) return { runs, done: false }

  if (toRetry.length > 0) {
    await rerunFailedWorkflows(toRetry)
    for (const run of toRetry) retriedRunIds.add(run.id)
    runsCache = undefined
  }

  console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
  await setTimeout(POLLING_INTERVAL * 60_000)
  console.log('Retrying.')
  return pollUntilDone()
}

async function rerunFailedWorkflows (workflowRuns) {
  await Promise.all(
    workflowRuns.map(async workflowRun => {
      console.log(`Rerunning ${workflowRun.conclusion} workflow run ${workflowRun.id} (${workflowRun.name}).`)
      try {
        await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: workflowRun.id })
      } catch (err) {
        if (err.status === 403) {
          const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
            owner, repo, run_id: workflowRun.id, filter: 'latest', per_page: 100,
          })
          const hasFailedJobs = jobs.some(j => failureConclusions.has(j.conclusion))
          if (!hasFailedJobs) {
            const { id, name } = workflowRun
            console.log(`Workflow run ${id} (${name}) has no failed jobs — stale conclusion, treating as passed.`)
            staleFailureRunIds.add(workflowRun.id)
            return
          }
        }
        throw err
      }
    })
  )
}

async function rerunOnStartup () {
  if (RUN_ATTEMPT <= 1) return
  const runs = await getRuns()
  const toRerun = runs.filter(r =>
    r.status === 'completed' &&
    failureConclusions.has(r.conclusion)
  )
  if (toRerun.length > 0) {
    console.log(`Rerunning ${toRerun.length} failed workflow(s) before polling.`)
    await rerunFailedWorkflows(toRerun)
    for (const run of toRerun) retriedRunIds.add(run.id)
    runsCache = undefined
    console.log(`Waiting for ${POLLING_INTERVAL} minutes before polling.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
  }
}

async function cancelRunningWorkflows (runs) {
  const running = runs.filter(r => r.status !== 'completed')
  if (running.length === 0) return
  console.log(`Cancelling ${running.length} still-running workflow(s).`)
  await Promise.all(
    running.map(run => {
      console.log(`Cancelling workflow run ${run.id} (${run.name}).`)
      return octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: run.id })
    })
  )
}

async function checkAllGreen () {
  await rerunOnStartup()

  const { runs, done } = await pollUntilDone()

  await printSummary(runs)

  console.log(`Waiting for ${processingPromises.length} workflow run report upload(s) to finish.`)
  await Promise.all(processingPromises)

  // Codecov's `manual_trigger` (`.codecov.yml`) holds off computing/posting the coverage status
  // until this fires, since uploads land one sibling workflow at a time rather than all at once.
  if (process.env.GITHUB_ACTIONS) {
    logUploads('codecov', [await sendCodecovNotifications(HEAD_SHA)])
  }

  if (!done) {
    console.log(`State is still pending after ${RETRIES} retries.`)
    await cancelRunningWorkflows(runs)
    process.exitCode = 1
    return
  }

  const failedRuns = runs.filter(r =>
    failureConclusions.has(r.conclusion) && !staleFailureRunIds.has(r.id)
  )

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
  const totalSeconds = Math.floor((end - start) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

async function printSummary (runs) {
  const rows = runs
    .sort((a, b) => a.name.localeCompare(b.name))
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
