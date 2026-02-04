/* eslint-disable no-console */

import { writeFileSync } from 'fs'
import { inspect } from 'util'
import { Octokit } from 'octokit'
import pLimit from 'p-limit'

const {
  BRANCH,
  CI,
  DAYS = '1',
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  MERGE = 'true',
  OCCURRENCES = '1',
  UNTIL,
  GITHUB_TOKEN,
} = process.env

const ONE_DAY = 24 * 60 * 60 * 1000

const octokit = new Octokit({ auth: GITHUB_TOKEN })
const limit = pLimit(25)
const workflows = [
  '.github/workflows/apm-capabilities.yml',
  '.github/workflows/apm-integrations.yml',
  '.github/workflows/appsec.yml',
  '.github/workflows/debugger.yml',
  '.github/workflows/llmobs.yml',
  '.github/workflows/platform.yml',
  '.github/workflows/profiling.yml',
  '.github/workflows/project.yml',
  '.github/workflows/serverless.yml',
  '.github/workflows/system-tests.yml',
  '.github/workflows/test-optimization.yml',
]

const flaky = {}
const reported = new Set()
const untilMatch = UNTIL?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0]
const endDate = untilMatch ?? new Date().toISOString().slice(0, 10)
const startDate = new Date(new Date(endDate).getTime() - (Number(DAYS) - 1) * ONE_DAY).toISOString().slice(0, 10)

let totalCount = 0
let flakeCount = 0

const LIMIT = 50

/**
 * @typedef {{
 *   status?: number,
 *   url?: string,
 *   headers?: Record<string, string | number | undefined>,
 *   data?: { jobs?: unknown }
 * }} JobsAttemptResponse
 */

/**
 * @param {JobsAttemptResponse} response
 */
function redactHeaders (response) {
  if (typeof response?.headers === 'object' && response.headers) {
    for (const key of Object.keys(response.headers)) {
      if (key.toLowerCase() === 'authorization') response.headers[key] = '<redacted>'
    }
  }

  return response
}

async function checkWorkflowRuns (id, page = 1) {
  // This only gets the last attempt of every run.
  const response = await limit(() => octokit.rest.actions.listWorkflowRuns({
    owner: 'DataDog',
    repo: 'dd-trace-js',
    page,
    per_page: LIMIT,
    status: 'success',
    created: `${startDate}..${endDate}`,
    branch: BRANCH,
    workflow_id: id,
  }))

  const runs = response.data.workflow_runs

  // Either there were no runs for the period or we've reached the last page and
  // there are no more results.
  if (runs.length === 0) return

  const promises = []

  for (const run of runs) {
    totalCount++

    if (run.run_attempt === undefined) {
      console.warn(`Unexpected run attempt shape (${inspect(run, { depth: Infinity })})`)
      continue
    }

    // Filter out first attempts to get only reruns. The idea is that if a rerun
    // is successful it means any failed jobs in the previous run were flaky
    // since a rerun without any change made them pass.
    if (run.run_attempt === 1) continue

    flakeCount++

    promises.push(checkWorkflowJobs(run.id, run.run_attempt - 1))
  }

  // Only request next page if the current page was full.
  if (runs.length === LIMIT) {
    promises.push(checkWorkflowRuns(id, page + 1))
  }

  return Promise.all(promises)
}

async function checkWorkflowJobs (id, attempt, page = 1) {
  if (attempt < 1) return

  /** @type {JobsAttemptResponse | undefined} */
  const response = await limit(() => octokit.rest.actions.listJobsForWorkflowRunAttempt({
    attempt_number: attempt,
    owner: 'DataDog',
    repo: 'dd-trace-js',
    run_id: id,
    page,
    per_page: LIMIT,
  }))

  /** @type {unknown} */
  const jobs = response?.data?.jobs

  if (!Array.isArray(jobs)) {
    throw new TypeError(`Unexpected jobs response shape (${inspect(redactHeaders(response), { depth: Infinity })})`)
  }

  for (const job of jobs) {
    if (job.conclusion !== 'failure') continue

    const workflow = job.workflow_name
    // Merge matrix runs of same job together.
    const name = MERGE === 'true' ? job.name.split(' ')[0] : job.name

    flaky[workflow] ??= {}
    flaky[workflow][name] ??= []
    flaky[workflow][name].push(job.html_url)

    if (flaky[workflow][name].length >= OCCURRENCES) {
      reported.add(workflow)
    }
  }

  // We've reached the last page and there are no more results.
  if (jobs.length < LIMIT) {
    // Check previous attempt to include successive failures.
    return checkWorkflowJobs(id, attempt - 1)
  }

  return checkWorkflowJobs(id, attempt, page + 1)
}

await Promise.all(workflows.map(w => checkWorkflowRuns(w)))

// TODO: Report this somewhere useful instead.

const dateRange = startDate === endDate ? `on ${endDate}` : `from ${startDate} to ${endDate}`
const logString = `jobs with at least ${OCCURRENCES} occurrences seen ${dateRange} (UTC)`

if (Object.keys(flaky).length === 0) {
  console.log(`*No flaky ${logString}`)
} else {
  const workflowSuccessRate = Number(((1 - flakeCount / totalCount) * 100).toFixed(1))
  const pipelineSuccessRate = Number((((workflowSuccessRate / 100) ** workflows.length) * 100).toFixed(1))
  const pipelineBadge = pipelineSuccessRate >= 85 ? '🟢' : pipelineSuccessRate >= 75 ? '🟡' : '🔴'

  let markdown = ''
  let slack = ''

  markdown += `**Flaky ${logString}**\n`
  slack += String.raw`*Flaky ${logString}*\n`

  for (const [workflow, jobs] of Object.entries(flaky).sort()) {
    if (!reported.has(workflow)) continue

    markdown += `* ${workflow}\n`
    slack += String.raw`  ●   ${workflow}\n`

    for (const [job, urls] of Object.entries(jobs).sort()) {
      if (urls.length < OCCURRENCES) continue
      // Padding is needed because Slack doesn't show single digits as links.
      const markdownLinks = urls.map((url, idx) => `[${String(idx + 1).padStart(2, '0')}](${url})`)
      const runsBadge = urls.length >= 3 ? ' 🔴' : urls.length === 2 ? ' 🟡' : ''
      markdown += `    * ${job} (${markdownLinks.join(', ')})${runsBadge}\n`
      slack += String.raw`         ○   ${job} (${urls.length})${runsBadge}\n`
    }
  }

  markdown += '\n'
  markdown += '**Flakiness stats**\n'
  markdown += `* Total runs: ${totalCount}\n`
  markdown += `* Flaky runs: ${flakeCount}\n`
  markdown += `* Workflow success rate: ${workflowSuccessRate}%\n`
  markdown += `* Pipeline success rate (approx): ${pipelineSuccessRate}% ${pipelineBadge}`

  if (GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    const link = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

    slack += String.raw`\n`
    slack += `View full report with links to failures on <${link}|GitHub>.`
  }

  slack += String.raw`\n`
  slack += String.raw`*Flakiness stats*\n`
  slack += String.raw`  ●   Total runs: ${totalCount}\n`
  slack += String.raw`  ●   Flaky runs: ${flakeCount}\n`
  slack += String.raw`  ●   Workflow success rate: ${workflowSuccessRate}%\n`
  slack += `  ●   Pipeline success rate (approx): ${pipelineSuccessRate}% ${pipelineBadge}`

  console.log(markdown)

  // TODO: Make this an option instead.
  if (CI) {
    writeFileSync('flakiness.md', markdown)
    writeFileSync('flakiness.txt', slack)
  }
}
