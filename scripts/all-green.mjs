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
const checkConclusionEmojis = {
  action_required: '🔶',
  cancelled: '🚫',
  failure: '❌',
  neutral: '⚪',
  success: '✅',
  skipped: '⏭️',
  stale: '🔄',
  timed_out: '⌛',
}

let retries = 0

async function hasCompleted () {
  const { data: inProgressRuns } = await octokit.rest.checks.listForRef({
    ...params,
    per_page: 1, // Minimum is 1 but we don't need any pages.
    status: 'in_progress',
  })

  // If there are any in progress runs it means we're not ready to check
  // statuses. We will always have minimum 1 for the All Green job.
  if (inProgressRuns.total_count > 1) return false

  const { data: queuedRuns } = await octokit.rest.checks.listForRef({
    ...params,
    per_page: 1, // Minimum is 1 but we don't need any pages.
    status: 'queued',
  })

  // Same as above, but jobs that are queued are not even in progress yet.
  if (queuedRuns.total_count > 0) return false

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

async function checkAllGreen () {
  let latestRuns

  try {
    await checkCompleted()
  } finally {
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
    latestRuns = [...latestByName.values()]

    await printSummary(latestRuns)
  }

  const allGreen = !latestRuns.some(run => (
    run.conclusion === 'failure' || run.conclusion === 'timed_out'
  ))

  if (allGreen) {
    console.log('All jobs were successful.')
  } else {
    throw new Error('One or more jobs failed.')
  }
}

async function printSummary (checkRuns) {
  const runs = checkRuns.map(run => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion
      ? `${run.conclusion} ${checkConclusionEmojis[run.conclusion]}`
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
