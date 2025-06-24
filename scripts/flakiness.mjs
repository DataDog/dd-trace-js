'use strict'

/* eslint-disable no-console */

import { Octokit } from 'octokit'

const { DAYS = '1', OCCURRENCES = '1' } = process.env

const ONE_DAY = 24 * 60 * 60 * 1000

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const workflows = [
  '.github/workflows/apm-capabilities.yml',
  '.github/workflows/apm-integrations.yml',
  '.github/workflows/appsec.yml',
  '.github/workflows/debugger.yml',
  '.github/workflows/lambda.yml',
  '.github/workflows/llmobs.yml',
  '.github/workflows/platform.yml',
  '.github/workflows/profiling.yml',
  '.github/workflows/project.yml',
  '.github/workflows/system-tests.yml',
  '.github/workflows/test-optimization.yml'
]

const flaky = {}
const reported = new Set()

async function checkWorkflowRuns (id, page = 1) {
  const response = await octokit.rest.actions.listWorkflowRuns({
    owner: 'DataDog',
    repo: 'dd-trace-js',
    page,
    per_page: 100, // max is 100
    status: 'success',
    workflow_id: id
  })

  const runs = response.data.workflow_runs

  // Either there were no runs for the period or we've reached the last page and
  // there are no more results.
  if (runs.length === 0) return

  const promises = []

  for (const run of runs) {
    // Filter out first attempts to get only reruns. The idea is that if a rerun
    // is successful it means any failed jobs in the previous run were flaky
    // since a rerun without any change made them pass.
    if (run.run_attempt === 1) continue
    if (Date.parse(run.created_at) < Date.now() - DAYS * ONE_DAY) {
      return Promise.all(promises)
    }

    promises.push(checkWorkflowJobs(run.id))
  }

  promises.push(checkWorkflowRuns(id, page + 1))

  return Promise.all(promises)
}

async function checkWorkflowJobs (id, page = 1) {
  const response = await octokit.rest.actions.listJobsForWorkflowRunAttempt({
    attempt_number: 1, // ignore other attempts to keep things simple
    owner: 'DataDog',
    repo: 'dd-trace-js',
    run_id: id,
    page,
    per_page: 100 // max is 100
  })

  const { jobs } = response.data

  // We've reached the last page and there are no more results.
  if (jobs.length === 0) return

  for (const job of jobs) {
    if (job.conclusion !== 'failure') continue

    const workflow = job.workflow_name
    const name = job.name.split(' ')[0] // Merge matrix runs of same job together.

    flaky[workflow] ??= {}
    flaky[workflow][name] ??= []
    flaky[workflow][name].push(job.html_url)

    if (flaky[workflow][name].length >= OCCURRENCES) {
      reported.add(workflow)
    }
  }

  return checkWorkflowJobs(id, page + 1)
}

await Promise.all(workflows.map(w => checkWorkflowRuns(w)))

// TODO: Report this somewhere useful instead.
if (Object.keys(flaky).length === 0) {
  console.log(
    `*No flaky jobs with at least ${OCCURRENCES} occurrences seen in the last ${DAYS > 1 ? `${DAYS} days` : 'day'}*`
  )
} else {
  console.log(
    `*Flaky jobs with at least ${OCCURRENCES} occurrences seen in the last ${DAYS > 1 ? `${DAYS} days` : 'day'}*`
  )
  for (const [workflow, jobs] of Object.entries(flaky).sort()) {
    if (!reported.has(workflow)) continue
    console.log(`* ${workflow}`)
    for (const [job, urls] of Object.entries(jobs).sort()) {
      if (urls.length < OCCURRENCES) continue
      console.log(`    * ${job}`)
      for (const url of urls.sort()) {
        console.log(`        * [${url.replace('https://github.com/DataDog/', '')}](${url})`)
      }
    }
  }
}
