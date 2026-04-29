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

const maxRerunFailedJobs = 3

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

let retries = 0
let hasRerun = false

// Cache of {etag, totalCount} per check status. GitHub returns 304 Not Modified
// for unchanged responses when If-None-Match matches, and those don't count
// against the rate limit.
const checkCountCache = new Map()

async function getCheckCount (status) {
  const cached = checkCountCache.get(status)
  try {
    const { data, headers } = await octokit.rest.checks.listForRef({
      ...params,
      per_page: 1, // Minimum is 1 but we don't need any pages.
      status,
      headers: cached ? { 'if-none-match': cached.etag } : {},
    })
    checkCountCache.set(status, { etag: headers.etag, totalCount: data.total_count })
    return data.total_count
  } catch (err) {
    if (err.status === 304 && cached) return cached.totalCount
    throw err
  }
}

async function hasCompleted () {
  // If there are any in progress runs it means we're not ready to check
  // statuses. We will always have minimum 1 for the All Green job.
  if (await getCheckCount('in_progress') > 1) return false

  // Same as above, but jobs that are queued are not even in progress yet.
  if (await getCheckCount('queued') > 0) return false

  return true
}

async function checkCompleted () {
  if (!await hasCompleted()) {
    retries++

    if (RETRIES && retries > RETRIES) {
      throw new Error(`State is still pending after ${RETRIES} retries.`)
    }

    console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    console.log('Retrying.')
    await checkCompleted()
  }
}

async function getLatestRuns () {
  const checkRuns = await octokit.paginate(
    'GET /repos/:owner/:repo/commits/:ref/check-runs',
    {
      ...params,
      per_page: 100,
    }
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

  return [...latestByName.values()]
}

async function rerunFailedWorkflows (failedRuns) {
  const failedCountByCheckSuiteId = new Map()
  for (const run of failedRuns) {
    const id = run.check_suite?.id
    if (id !== undefined) {
      failedCountByCheckSuiteId.set(id, (failedCountByCheckSuiteId.get(id) ?? 0) + 1)
    }
  }

  const eligibleSuiteIds = [...failedCountByCheckSuiteId.entries()]
    .filter(([, count]) => count <= maxRerunFailedJobs)
    .map(([id]) => id)

  // If a workflow has many jobs failed, it's unlikely to be flakiness to no
  // point in re-running.
  if (eligibleSuiteIds.length < failedCountByCheckSuiteId.size) {
    console.log(
      `Skipping rerun for ${failedCountByCheckSuiteId.size - eligibleSuiteIds.length} workflow(s) ` +
      `with more than ${maxRerunFailedJobs} failed job(s).`
    )
  }

  const workflowRunsPerSuite = await Promise.all(
    eligibleSuiteIds.map(checkSuiteId =>
      octokit.rest.actions.listWorkflowRunsForRepo({ owner, repo, check_suite_id: checkSuiteId })
        .then(({ data }) => data.workflow_runs)
    )
  )

  const workflowRuns = workflowRunsPerSuite.flat()

  await Promise.all(
    workflowRuns.map(workflowRun => {
      console.log(`Rerunning failed jobs for workflow run ${workflowRun.id} (${workflowRun.name}).`)
      return octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: workflowRun.id })
    })
  )

  return workflowRuns.length > 0
}

async function checkAllGreen () {
  let latestRuns

  try {
    await checkCompleted()
  } finally {
    latestRuns = await getLatestRuns()
  }

  const failedRuns = latestRuns.filter(run =>
    run.conclusion === 'failure' || run.conclusion === 'timed_out'
  )

  if (failedRuns.length === 0) {
    await printSummary(latestRuns)
    console.log('All jobs were successful.')
    return
  }

  if (!hasRerun) {
    hasRerun = true
    console.log(`${failedRuns.length} job(s) failed. Rerunning failed workflows...`)
    const didRerun = await rerunFailedWorkflows(failedRuns)
    if (didRerun) {
      retries = 0
      console.log(`Waiting for ${POLLING_INTERVAL} minutes before polling for rerun results.`)
      await setTimeout(POLLING_INTERVAL * 60_000)
      await checkAllGreen()
      return
    }
  }

  await printSummary(latestRuns)
  throw new Error('One or more jobs failed.')
}

async function printSummary (checkRuns) {
  const runs = [...checkRuns]
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
