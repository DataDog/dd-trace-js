'use strict'

/* eslint-disable no-console */

import { Octokit } from 'octokit'

const ONE_DAY = 24 * 60 * 60 * 1000

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const workflows = [
  '.github/workflows/apm-capabilities.yml',
  '.github/workflows/apm-integrations.yml',
  '.github/workflows/appsec.yml',
  '.github/workflows/debugger.yml',
  '.github/workflows/llmobs.yml',
  '.github/workflows/platform.yml',
  '.github/workflows/project.yml',
  '.github/workflows/system-tests.yml',
  '.github/workflows/test-optimization.yml'
]

const flaky = {}
const runPromises = []
const jobPromises = []

for (const workflow of workflows) {
  const runPromise = octokit.rest.actions.listWorkflowRuns({
    owner: 'DataDog',
    repo: 'dd-trace-js',
    per_page: 100, // max is 100 which is enough data for our purpose
    status: 'success',
    workflow_id: workflow
  })

  runPromises.push(runPromise)
}

const runResponses = await Promise.all(runPromises)

for (const runResponse of runResponses) {
  for (const run of runResponse.data.workflow_runs) {
    if (Date.parse(run.created_at) < Date.now() - ONE_DAY) break
    if (run.run_attempt === 1) continue

    const jobPromise = octokit.rest.actions.listJobsForWorkflowRunAttempt({
      attempt_number: 1, // ignore other attempts to keep things simple
      owner: 'DataDog',
      repo: 'dd-trace-js',
      run_id: run.id,
      per_page: 100 // max is 100 which covers our biggest workflow
    })

    jobPromises.push(jobPromise)
  }
}

const jobResponses = await Promise.all(jobPromises)

for (const jobResponse of jobResponses) {
  const { jobs } = jobResponse.data

  for (const job of jobs) {
    if (job.conclusion !== 'failure') continue

    const workflow = job.workflow_name

    flaky[workflow] = flaky[workflow] || {}
    flaky[workflow][job.name] = flaky[workflow][job.name] || []
    flaky[workflow][job.name].push(job.html_url)
  }
}

// TODO: Report this somewhere useful instead.
if (Object.keys(flaky).length === 0) {
  console.log('*No flaky jobs seen in the last 24h*')
} else {
  console.log('*Flaky jobs seen in the last 24h*')
  for (const workflow in flaky) {
    console.log(`* ${workflow}`)
    for (const job in flaky[workflow]) {
      console.log(`    * ${job}`)
      for (const url of flaky[workflow][job]) {
        console.log(`        * ${url}`)
      }
    }
  }
}
