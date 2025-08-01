/* eslint-disable no-console */

import { Octokit } from 'octokit'

const {
  BRANCH,
  DAYS = '1',
  OCCURRENCES = '1',
  UNTIL
} = process.env

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
const untilMatch = UNTIL?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0]
const endDate = untilMatch ?? new Date().toISOString().slice(0, 10)
const startDate = new Date(new Date(endDate).getTime() - (DAYS - 1) * ONE_DAY).toISOString().slice(0, 10)

let totalCount = 0
let flakeCount = 0

async function checkWorkflowRuns (id, page = 1) {
  const response = await octokit.rest.actions.listWorkflowRuns({
    owner: 'DataDog',
    repo: 'dd-trace-js',
    page,
    per_page: 100, // max is 100
    status: 'success',
    created: `${startDate}..${endDate}`,
    branch: BRANCH,
    workflow_id: id
  })

  const runs = response.data.workflow_runs

  // Either there were no runs for the period or we've reached the last page and
  // there are no more results.
  if (runs.length === 0) return

  const promises = []

  for (const run of runs) {
    totalCount++

    // Filter out first attempts to get only reruns. The idea is that if a rerun
    // is successful it means any failed jobs in the previous run were flaky
    // since a rerun without any change made them pass.
    if (run.run_attempt === 1) continue

    flakeCount++

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

const dateRange = startDate === endDate ? `on ${endDate}` : `from ${startDate} to ${endDate}`
const logString = `jobs with at least ${OCCURRENCES} occurrences seen ${dateRange} (UTC)*`

if (Object.keys(flaky).length === 0) {
  console.log(`*No flaky ${logString}`)
} else {
  const workflowSuccessRate = +((1 - flakeCount / totalCount) * 100).toFixed(1)
  const pipelineSuccessRate = +((workflowSuccessRate / 100) ** workflows.length * 100).toFixed(1)
  const pipelineBadge = pipelineSuccessRate >= 85 ? '🟢' : pipelineSuccessRate >= 75 ? '🟡' : '🔴'

  console.log(`*Flaky ${logString}`)
  for (const [workflow, jobs] of Object.entries(flaky).sort()) {
    if (!reported.has(workflow)) continue
    console.log(`* ${workflow}`)
    for (const [job, urls] of Object.entries(jobs).sort()) {
      if (urls.length < OCCURRENCES) continue
      // Padding is needed because Slack doesn't show single digits as links.
      const links = urls.map((url, idx) => `[${String(idx + 1).padStart(2, '0')}](${url})`)
      const runsBadge = urls.length >= 3 ? ' 🔴' : urls.length === 2 ? ' 🟡' : ''
      console.log(`    * ${job} (${links.join(', ')})${runsBadge}`)
    }
  }
  console.log('*Flakiness stats*')
  console.log(`* Total runs: ${totalCount}`)
  console.log(`* Flaky runs: ${flakeCount}`)
  console.log(`* Workflow success rate: ${workflowSuccessRate}%`)
  console.log(`* Pipeline success rate (approx): ${pipelineSuccessRate}% ${pipelineBadge}`)
}
