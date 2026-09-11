/* eslint-disable no-console */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'DataDog'
const REPO = 'dd-trace-js'
const ALL_GREEN_WORKFLOW = '.github/workflows/all-green.yml'
const SYSTEM_TESTS_WORKFLOW = '.github/workflows/system-tests.yml'
const REPORT_WORKFLOW = '.github/workflows/flakiness.yml'
const PAGE_SIZE = 100
const WARNING_MS = 7 * 60 * 1000
const HARD_LIMIT_MS = 9 * 60 * 1000
const SLACK_WORKFLOW_LIMIT = 5
const SLACK_DETAIL_LIMIT = 3
const MARKDOWN_DETAIL_LIMIT = 10
const MAX_GREEN_AGE_DAYS = 7

const genericOwners = new Set(['dd-trace-js', 'dd-octo-sts'])

/**
 * @typedef {{
 *   name: string,
 *   conclusion?: string,
 *   started_at?: string,
 *   completed_at?: string,
 * }} WorkflowStep
 */

/**
 * @typedef {{
 *   id: number,
 *   name: string,
 *   html_url: string,
 *   conclusion?: string,
 *   started_at?: string,
 *   completed_at?: string,
 *   steps?: WorkflowStep[],
 * }} WorkflowJob
 */

/**
 * @typedef {{
 *   id: number,
 *   name: string,
 *   path: string,
 *   event: string,
 *   status: string,
 *   conclusion?: string,
 *   head_sha: string,
 *   run_attempt?: number,
 *   run_started_at?: string,
 *   updated_at?: string,
 *   created_at?: string,
 *   html_url: string,
 * }} WorkflowRun
 */

/**
 * @typedef {{
 *   name: string,
 *   durationMs: number,
 *   jobName: string,
 *   jobUrl: string,
 *   jobDurationMs: number,
 * }} ScenarioDuration
 */

/**
 * @param {string | undefined} startedAt
 * @param {string | undefined} completedAt
 * @returns {number | undefined}
 */
export function getDurationMs (startedAt, completedAt) {
  if (!startedAt || !completedAt) return

  const duration = Date.parse(completedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

/**
 * @param {number | undefined} durationMs
 * @returns {string}
 */
export function formatDuration (durationMs) {
  if (durationMs === undefined) return 'unknown'

  const seconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  return minutes > 0 ? `${minutes}m${String(remainingSeconds).padStart(2, '0')}s` : `${seconds}s`
}

/**
 * @param {number | undefined} durationMs
 * @returns {'hard' | 'warning' | 'healthy' | 'unknown'}
 */
export function classifyDuration (durationMs) {
  if (durationMs === undefined) return 'unknown'
  if (durationMs >= HARD_LIMIT_MS) return 'hard'
  if (durationMs > WARNING_MS) return 'warning'
  return 'healthy'
}

/**
 * @param {string} workflowPath
 * @returns {string}
 */
function normalizeWorkflowPath (workflowPath) {
  return workflowPath.split('@', 1)[0]
}

/**
 * @param {string} contents
 * @returns {{ defaultTeam?: string, teams: Map<string, string> }}
 */
export function parseWorkflowTeams (contents) {
  const teams = new Map()
  let defaultTeam

  for (const sourceLine of contents.split('\n')) {
    const line = sourceLine.split('#', 1)[0].trim()
    if (!line) continue

    const [pattern, ...owners] = line.split(/\s+/)
    if (!pattern.startsWith('/.github/workflows/')) continue

    const specialists = owners
      .map(owner => owner.replace(/^@datadog\//i, '').replace(/^@/, ''))
      .filter(owner => !genericOwners.has(owner.toLowerCase()))

    if (specialists.length === 0) continue

    if (pattern === '/.github/workflows/*.yml') {
      defaultTeam = specialists.join(', ')
    } else if (!pattern.includes('*')) {
      teams.set(pattern.slice(1), specialists.join(', '))
    }
  }

  return { defaultTeam, teams }
}

/**
 * @param {WorkflowRun} run
 * @param {{ defaultTeam?: string, teams: Map<string, string> }} workflowTeams
 * @returns {string}
 */
function getTeam (run, workflowTeams) {
  const workflowPath = normalizeWorkflowPath(run.path)
  if (workflowPath === SYSTEM_TESTS_WORKFLOW) return 'multiple teams'
  return workflowTeams.teams.get(workflowPath) ?? workflowTeams.defaultTeam ?? 'unassigned'
}

/**
 * @param {WorkflowJob} job
 * @returns {ScenarioDuration[]}
 */
function getScenarios (job) {
  const jobDurationMs = getDurationMs(job.started_at, job.completed_at)
  if (jobDurationMs === undefined || !job.steps) return []

  const scenarios = []
  for (const step of job.steps) {
    if (step.conclusion === 'skipped') continue

    const match = step.name.match(/^Run (.+) scenario$/)
    const durationMs = getDurationMs(step.started_at, step.completed_at)
    if (!match || durationMs === undefined) continue

    scenarios.push({
      name: match[1],
      durationMs,
      jobName: job.name,
      jobUrl: job.html_url,
      jobDurationMs,
    })
  }

  return scenarios
}

/**
 * @param {WorkflowJob[]} jobs
 * @returns {{
 *   jobs: Array<WorkflowJob & { durationMs: number, scenarioDurationMs: number }>,
 *   scenarios: ScenarioDuration[],
 * }}
 */
export function analyzeJobs (jobs) {
  const analyzedJobs = []
  const scenariosByName = new Map()

  for (const job of jobs) {
    if (job.conclusion === 'skipped') continue

    const durationMs = getDurationMs(job.started_at, job.completed_at)
    if (durationMs === undefined) continue

    const scenarios = getScenarios(job)
    const scenarioDurationMs = scenarios.reduce((sum, scenario) => sum + scenario.durationMs, 0)
    analyzedJobs.push({ ...job, durationMs, scenarioDurationMs })

    for (const scenario of scenarios) {
      const previous = scenariosByName.get(scenario.name)
      if (!previous || scenario.durationMs > previous.durationMs) {
        scenariosByName.set(scenario.name, scenario)
      }
    }
  }

  analyzedJobs.sort((a, b) => b.durationMs - a.durationMs)
  const scenarios = [...scenariosByName.values()].sort((a, b) => b.durationMs - a.durationMs)

  return { jobs: analyzedJobs, scenarios }
}

/**
 * @param {string} value
 * @returns {string}
 */
function markdownText (value) {
  return value.replaceAll('|', String.raw`\|`).replaceAll(/\s+/g, ' ').trim()
}

/**
 * @param {string} value
 * @returns {string}
 */
function slackText (value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
function truncate (value, maxLength = 90) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

/**
 * @param {number | undefined} durationMs
 * @returns {string}
 */
function statusIcon (durationMs) {
  const status = classifyDuration(durationMs)
  if (status === 'hard') return '🔴'
  if (status === 'warning') return '⚠️'
  if (status === 'healthy') return '✅'
  return '❔'
}

/**
 * @param {{ actions: Record<string, Function> }} api
 * @returns {Promise<WorkflowRun | undefined>}
 */
async function getLatestGreenRun (api) {
  const response = await api.actions.listWorkflowRuns({
    owner: OWNER,
    repo: REPO,
    workflow_id: ALL_GREEN_WORKFLOW,
    branch: 'master',
    event: 'push',
    status: 'success',
    per_page: 1,
  })

  return response.data.workflow_runs[0]
}

/**
 * @param {{ actions: Record<string, Function> }} api
 * @param {string} sha
 * @param {number} [page]
 * @returns {Promise<WorkflowRun[]>}
 */
async function getRunsForCommit (api, sha, page = 1) {
  const response = await api.actions.listWorkflowRunsForRepo({
    owner: OWNER,
    repo: REPO,
    head_sha: sha,
    event: 'push',
    page,
    per_page: PAGE_SIZE,
  })
  const runs = response.data.workflow_runs

  if (runs.length < PAGE_SIZE) return runs
  return [...runs, ...await getRunsForCommit(api, sha, page + 1)]
}

/**
 * @param {{ actions: Record<string, Function> }} api
 * @param {WorkflowRun} run
 * @param {number} [page]
 * @returns {Promise<WorkflowJob[]>}
 */
async function getJobs (api, run, page = 1) {
  const response = await api.actions.listJobsForWorkflowRunAttempt({
    owner: OWNER,
    repo: REPO,
    run_id: run.id,
    attempt_number: run.run_attempt ?? 1,
    page,
    per_page: PAGE_SIZE,
  })
  const jobs = response.data.jobs

  if (jobs.length < PAGE_SIZE) return jobs
  return [...jobs, ...await getJobs(api, run, page + 1)]
}

/**
 * @param {WorkflowRun[]} runs
 * @returns {WorkflowRun[]}
 */
function selectRuns (runs) {
  const selected = new Map()

  for (const run of runs) {
    const workflowPath = normalizeWorkflowPath(run.path)
    if (run.event !== 'push' || run.status !== 'completed') continue
    if (workflowPath === ALL_GREEN_WORKFLOW || workflowPath === REPORT_WORKFLOW) continue

    const previous = selected.get(workflowPath)
    if (!previous || (run.run_attempt ?? 1) > (previous.run_attempt ?? 1)) {
      selected.set(workflowPath, run)
    }
  }

  return [...selected.values()]
}

/**
 * @param {{ actions: Record<string, Function> }} api
 * @param {string} codeowners
 * @param {Date} [now]
 * @returns {Promise<{
 *   anchor: WorkflowRun,
 *   stale: boolean,
 *   workflows: Array<WorkflowRun & {
 *     durationMs?: number,
 *     team: string,
 *     analysis?: ReturnType<typeof analyzeJobs>,
 *   }>,
 * }>}
 */
export async function collectSnapshot (api, codeowners, now = new Date()) {
  const anchor = await getLatestGreenRun(api)
  if (!anchor) throw new Error('No successful All Green push was found on master.')

  const workflowTeams = parseWorkflowTeams(codeowners)
  const runs = selectRuns(await getRunsForCommit(api, anchor.head_sha))
  const workflows = runs.map(run => ({
    ...run,
    durationMs: getDurationMs(run.run_started_at, run.updated_at),
    team: getTeam(run, workflowTeams),
  }))

  await Promise.all(workflows.map(async workflow => {
    if (classifyDuration(workflow.durationMs) === 'healthy') return
    if (classifyDuration(workflow.durationMs) === 'unknown') return

    workflow.analysis = analyzeJobs(await getJobs(api, workflow))
  }))

  workflows.sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1))

  const anchorDate = Date.parse(anchor.updated_at ?? anchor.created_at ?? '')
  const maxAgeMs = MAX_GREEN_AGE_DAYS * 24 * 60 * 60 * 1000
  const stale = Number.isFinite(anchorDate) && now.getTime() - anchorDate > maxAgeMs

  return { anchor, stale, workflows }
}

/**
 * @param {Awaited<ReturnType<typeof collectSnapshot>>} snapshot
 * @returns {string}
 */
export function createMarkdownReport (snapshot) {
  const { anchor, stale, workflows } = snapshot
  const sha = anchor.head_sha.slice(0, 7)
  let markdown = '\n\n# CI duration report\n\n'

  markdown += `Latest green master commit: [\`${sha}\`](${anchor.html_url})\n\n`
  markdown += [
    'Warning: over 7 minutes. Hard limit: 9 minutes or longer.',
    'All Green is not measured.\n',
  ].join(' ')
  if (stale) markdown += `\n> Warning: this green commit is more than ${MAX_GREEN_AGE_DAYS} days old.\n`

  markdown += '\n## Workflow durations\n\n'
  markdown += '| Result | Workflow | Team | Duration | Slowest job |\n'
  markdown += '| --- | --- | --- | ---: | --- |\n'

  for (const workflow of workflows) {
    const slowestJob = workflow.analysis?.jobs[0]
    const slowest = slowestJob
      ? `[${markdownText(truncate(slowestJob.name))}](${slowestJob.html_url}) ` +
        `(${formatDuration(slowestJob.durationMs)})`
      : '—'

    markdown += `| ${statusIcon(workflow.durationMs)} | `
    markdown += `[${markdownText(workflow.name)}](${workflow.html_url}) | `
    markdown += `${markdownText(workflow.team)} | ${formatDuration(workflow.durationMs)} | ${slowest} |\n`
  }

  const offenders = workflows.filter(workflow => {
    const status = classifyDuration(workflow.durationMs)
    return status === 'warning' || status === 'hard'
  })

  if (offenders.length === 0) {
    markdown += '\nAll workflows completed within the warning threshold.\n'
    return markdown
  }

  for (const workflow of offenders) {
    const workflowPath = normalizeWorkflowPath(workflow.path)
    markdown += `\n## ${markdownText(workflow.name)} details\n\n`

    if (workflow.analysis?.jobs.length) {
      markdown += '| Job | Duration | Scenario time | Other time |\n'
      markdown += '| --- | ---: | ---: | ---: |\n'

      for (const job of workflow.analysis.jobs.slice(0, MARKDOWN_DETAIL_LIMIT)) {
        const otherDurationMs = Math.max(0, job.durationMs - job.scenarioDurationMs)
        markdown += `| [${markdownText(job.name)}](${job.html_url}) | ${formatDuration(job.durationMs)} | `
        markdown += `${formatDuration(job.scenarioDurationMs)} | ${formatDuration(otherDurationMs)} |\n`
      }
    } else {
      markdown += 'No timed jobs were returned by GitHub.\n'
    }

    if (workflowPath !== SYSTEM_TESTS_WORKFLOW || !workflow.analysis?.scenarios.length) continue

    markdown += '\n### Slowest unique scenarios across the matrix\n\n'
    markdown += '| Scenario | Duration | Job | Share of job |\n'
    markdown += '| --- | ---: | --- | ---: |\n'

    for (const scenario of workflow.analysis.scenarios.slice(0, MARKDOWN_DETAIL_LIMIT)) {
      const share = Math.round(scenario.durationMs / scenario.jobDurationMs * 100)
      markdown += `| ${markdownText(scenario.name)} | ${formatDuration(scenario.durationMs)} | `
      markdown += `[${markdownText(scenario.jobName)}](${scenario.jobUrl}) | ${share}% |\n`
    }
  }

  return markdown
}

/**
 * @param {Awaited<ReturnType<typeof collectSnapshot>>} snapshot
 * @param {string} reportUrl
 * @returns {string}
 */
export function createSlackReport (snapshot, reportUrl) {
  const { anchor, stale, workflows } = snapshot
  const offenders = workflows.filter(workflow => {
    const status = classifyDuration(workflow.durationMs)
    return status === 'warning' || status === 'hard'
  })
  const hardLimitCount = offenders.filter(workflow => classifyDuration(workflow.durationMs) === 'hard').length
  const lines = [`*CI duration — master \`${anchor.head_sha.slice(0, 7)}\`*`]

  if (stale) lines.push(`⚠️ Latest green commit is more than ${MAX_GREEN_AGE_DAYS} days old.`)

  if (offenders.length === 0) {
    lines.push('✅ All workflows completed within 7m.')
  } else {
    const noun = offenders.length === 1 ? 'workflow' : 'workflows'
    lines.push(`${offenders.length} ${noun} exceeded 7m; ${hardLimitCount} reached the 9m hard limit.`)

    for (const workflow of offenders.slice(0, SLACK_WORKFLOW_LIMIT)) {
      const workflowPath = normalizeWorkflowPath(workflow.path)
      const icon = statusIcon(workflow.durationMs)
      const team = workflowPath === SYSTEM_TESTS_WORKFLOW ? '' : ` — ${slackText(workflow.team)}`
      lines.push('', `${icon} *${slackText(workflow.name)}* — ${formatDuration(workflow.durationMs)}${team}`)

      const slowestJob = workflow.analysis?.jobs[0]
      if (slowestJob) {
        lines.push(`  Slowest job: <${slowestJob.html_url}|${slackText(truncate(slowestJob.name, 70))}> — ` +
          formatDuration(slowestJob.durationMs))
      }

      if (workflowPath === SYSTEM_TESTS_WORKFLOW && workflow.analysis?.scenarios.length) {
        lines.push('  Slowest scenarios across the matrix:')
        workflow.analysis.scenarios.slice(0, SLACK_DETAIL_LIMIT).forEach((scenario, index) => {
          const share = Math.round(scenario.durationMs / scenario.jobDurationMs * 100)
          lines.push(`  ${index + 1}. <${scenario.jobUrl}|${slackText(truncate(scenario.name, 62))}> — ` +
            `${formatDuration(scenario.durationMs)} (${share}% of job)`)
        })
      }
    }

    if (offenders.length > SLACK_WORKFLOW_LIMIT) {
      lines.push('', `…and ${offenders.length - SLACK_WORKFLOW_LIMIT} more.`)
    }
  }

  lines.push('', `<${reportUrl}|View the full GitHub report>.`)
  return lines.join(String.raw`\n`)
}

async function main () {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN } = process.env
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required.')

  const { Octokit } = await import('octokit')
  const octokit = new Octokit({ auth: GITHUB_TOKEN })
  const codeowners = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
  const snapshot = await collectSnapshot(octokit.rest, codeowners)
  const reportUrl = GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : snapshot.anchor.html_url
  const markdown = createMarkdownReport(snapshot)
  const slack = createSlackReport(snapshot, reportUrl)

  console.log(markdown)

  if (process.env.CI) {
    writeFileSync('ci-duration.md', markdown)
    writeFileSync('ci-duration.txt', slack)
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) await main()
