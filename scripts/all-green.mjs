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
  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

  if (!await hasCompleted()) {
    console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    console.log('Retrying.')
    retries++
    return checkCompleted()
  }
}

async function checkAllGreen () {
  let checkRuns

  try {
    checkCompleted()
  } finally {
    checkRuns = await octokit.paginate(
      'GET /repos/:owner/:repo/commits/:ref/check-runs',
      {
        ...params,
        per_page: 100,
      }
    )

    printSummary(checkRuns)
  }

  const allGreen = !checkRuns.some(run => (
    run.conclusion === 'failure' || run.conclusion === 'timed_out'
  ))

  if (allGreen) {
    console.log('All jobs were successful.')
  } else {
    throw new Error('One or more jobs failed.')
  }
}

async function printSummary (checkRuns) {
  const header = [
    { data: 'name', header: true },
    { data: 'status', header: true },
    { data: 'conclusion', header: true },
    { data: 'started_at', header: true },
    { data: 'completed_at', header: true },
  ]

  const body = checkRuns.map(run => [
    run.name,
    run.status,
    run.conclusion ? `${run.conclusion} ${checkConclusionEmojis[run.conclusion]}` : ' ',
    run.started_at,
    run.completed_at ?? ' ',
  ])

  await summary
    .addHeading('Checks Summary')
    .addTable([header, body])
    .write()
}

console.log(`Polling status for ref: ${ref}.`)

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  await setTimeout(DELAY * 60_000)
}

await checkAllGreen()
