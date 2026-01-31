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
  '.github/workflows/test-optimization.yml'
]

const flaky = {}
const reported = new Set()
const untilMatch = UNTIL?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0]
const endDate = untilMatch ?? new Date().toISOString().slice(0, 10)
const startDate = new Date(new Date(endDate).getTime() - (Number(DAYS) - 1) * ONE_DAY).toISOString().slice(0, 10)

let totalCount = 0
let flakeCount = 0

function redactHeaders (headers) {
  if (!headers || typeof headers !== 'object') return headers

  const out = { ...headers }
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'authorization') out[key] = '<redacted>'
  }
  return out
}

/**
 * @param {{ id: number, attempt: number, page: number }} params
 * @returns {Promise<{ jobs: unknown }>}
 */
async function fetchJobsAttemptRest (params) {
  const { id, attempt, page } = params
  const url = new URL(`https://api.github.com/repos/DataDog/dd-trace-js/actions/runs/${id}/attempts/${attempt}/jobs`)
  url.searchParams.set('page', String(page))
  url.searchParams.set('per_page', '100')

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GITHUB_TOKEN}`,
    }
  })

  const headers = Object.fromEntries(res.headers.entries())
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (err) {
    const summary = {
      status: res.status,
      headers: redactHeaders(headers),
      bodyLength: text.length,
      bodyPrefix: text.slice(0, 200),
    }
    throw new TypeError(
      `Failed to parse jobs REST response as JSON (${inspect(summary, { depth: 5 })}): ${inspect(err, { depth: 5 })}`
    )
  }
}

async function checkWorkflowRuns (id, page = 1) {
  // This only gets the last attempt of every run.
  const response = await limit(() => octokit.rest.actions.listWorkflowRuns({
    owner: 'DataDog',
    repo: 'dd-trace-js',
    page,
    per_page: 100, // max is 100
    status: 'success',
    created: `${startDate}..${endDate}`,
    branch: BRANCH,
    workflow_id: id
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
  if (runs.length === 100) {
    promises.push(checkWorkflowRuns(id, page + 1))
  }

  return Promise.all(promises)
}

async function checkWorkflowJobs (id, attempt, page = 1) {
  if (attempt < 1) return

  const response = await limit(() => octokit.rest.actions.listJobsForWorkflowRunAttempt({
    attempt_number: attempt,
    owner: 'DataDog',
    repo: 'dd-trace-js',
    run_id: id,
    page,
    per_page: 100 // max is 100
  }))

  /** @type {unknown} */
  let jobs = response?.data?.jobs

  // If Octokit returns an invalid shape (including `data: ''`), fall back to a raw REST fetch.
  if (!Array.isArray(jobs)) {
    console.warn(
      `Octokit jobs response invalid; attempting REST fallback: ${inspect({
        id,
        attempt,
        page,
        status: response?.status,
        url: response?.url,
        headers: redactHeaders(response?.headers),
        data: response?.data
      }, { depth: 5 })}`
    )

    const rest = await limit(() => fetchJobsAttemptRest({ id, attempt, page }))
    jobs = rest?.jobs
  }

  // Octokit v5 format: response.data.jobs is an array.
  if (!Array.isArray(jobs)) {
    throw new TypeError(`Unexpected jobs response shape (${inspect(response, { depth: Infinity })})`)
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
  if (jobs.length < 100) {
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
