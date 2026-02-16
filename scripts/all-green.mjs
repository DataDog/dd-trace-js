import { setTimeout } from 'timers/promises'
import { Octokit } from 'octokit'
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

let retries = 0

async function getAllGreen () {
  const { data: inProgressRuns } = await octokit.rest.checks.listForRef({
    ...params,
    per_page: 1, // Minimum is 1 but we don't need any pages.
    status: 'in_progress',
  })

  // If there are any in progress runs it means we're not ready to check
  // statuses. We will always have minimum 1 for the All Green job.
  if (inProgressRuns.total_count > 1) return

  const { data: queuedRuns } = await octokit.rest.checks.listForRef({
    ...params,
    per_page: 1, // Minimum is 1 but we don't need any pages.
    status: 'queued',
  })

  // Same as above, but jobs that are queued are not even in progress yet.
  if (queuedRuns.total_count > 1) return

  const completedRuns = await octokit.paginate(
    'GET /repos/:owner/:repo/commits/:ref/check-runs',
    {
      ...params,
      per_page: 100,
      status: 'completed',
    }
  )

  return completedRuns.some(run => (
    run.conclusion === 'failure' || run.conclusion === 'timed_out'
  ))
}

async function checkStatus () {
  if (RETRIES && retries > RETRIES) {
    throw new Error(`State is still pending after ${RETRIES} retries.`)
  }

  const allGreen = await getAllGreen()

  if (allGreen === undefined) {
    console.log(`Status is still pending, waiting for ${POLLING_INTERVAL} minutes before retrying.`)
    await setTimeout(POLLING_INTERVAL * 60_000)
    console.log('Retrying.')
    retries++
    return checkStatus()
  }

  if (allGreen) {
    console.log('All jobs were succesful.')
  } else {
    throw new Error('One or more jobs failed.')
  }
}

if (DELAY) {
  console.log(`Waiting for ${DELAY} minutes before starting.`)
  await setTimeout(DELAY * 60_000)
}

await checkStatus()
