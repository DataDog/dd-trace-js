import { mkdirSync, unlinkSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/* eslint-disable no-console */

const execFileAsync = promisify(execFile)

// Every sibling workflow's artifacts download at once, and a big run can have 100+ of them; opening
// that many concurrent connections to the GitHub API in one burst has been observed to blow past
// GitHub's connection/rate limits and fail every request for a run with a generic `fetch failed`
// (undici's error for a dropped connection), even though a smaller burst succeeds fine. Capping
// concurrency keeps the burst size sane; retrying absorbs the transient failures that still slip
// through.
const MAX_CONCURRENT_DOWNLOADS = 10

/**
 * Download and unzip a single artifact, retrying on failure with a backoff delay.
 *
 * @param {object} opts
 * @param {number} opts.runId
 * @param {{ id: number, name: string }} opts.artifact
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.token
 * @param {number} opts.retries
 * @param {number} opts.delayMs
 * @param {number} [attempt]
 * @returns {Promise<boolean>} whether the download succeeded
 */
async function downloadOne ({ runId, artifact, owner, repo, token, retries, delayMs }, attempt = 1) {
  const baseDir = artifact.name.startsWith('junit-') ? 'junit-results' : 'coverage-results'
  const dir = join(baseDir, String(runId), artifact.name)
  const tmpFile = `/tmp/artifact-${artifact.id}.zip`

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    mkdirSync(dir, { recursive: true })
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpFile))
    await execFileAsync('unzip', ['-oq', '-d', dir, tmpFile])
    return true
  } catch (err) {
    if (attempt > retries) {
      console.error(`Failed to download ${artifact.name} from run ${runId}: ${err.message}`)
      return false
    }
    console.log(`[retry ${attempt}/${retries}] ${artifact.name} from run ${runId}: ${err.message}`)
    await sleep(delayMs)
    return downloadOne({ runId, artifact, owner, repo, token, retries, delayMs }, attempt + 1)
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

/**
 * Pull tasks off the front of `tasks` one at a time until it's empty, so at most one task per
 * worker is ever in flight.
 *
 * @param {Array<() => Promise<void>>} tasks
 * @returns {Promise<void>}
 */
async function worker (tasks) {
  const task = tasks.shift()
  if (!task) return
  await task()
  return worker(tasks)
}

/**
 * Run a bounded number of `tasks` at a time instead of firing every one at once.
 *
 * @param {Array<() => Promise<void>>} tasks
 * @param {number} limit
 * @returns {Promise<void>}
 */
async function runWithConcurrencyLimit (tasks, limit) {
  const queue = [...tasks]
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker(queue)))
}

/**
 * @param {import('octokit').Octokit} octokit
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.token
 * @param {Array<{id: number}>} opts.runs
 * @param {number} [opts.retries]
 * @param {number} [opts.delayMs]
 * @returns {Promise<{ downloaded: number, failed: number }>}
 */
export async function downloadArtifacts (octokit, { owner, repo, token, runs, retries = 2, delayMs = 2000 }) {
  const artifactLists = await Promise.all(
    runs.map(run =>
      octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, {
        owner, repo, run_id: run.id, per_page: 100,
      }).then(artifacts => ({ runId: run.id, artifacts }))
    )
  )

  const toDownload = artifactLists.flatMap(({ runId, artifacts }) =>
    artifacts
      .filter(a => a.name.startsWith('junit-') || a.name.startsWith('coverage-'))
      .map(a => ({ runId, artifact: a }))
  )

  let failed = 0
  await runWithConcurrencyLimit(
    toDownload.map(({ runId, artifact }) => async () => {
      const ok = await downloadOne({ runId, artifact, owner, repo, token, retries, delayMs })
      if (!ok) failed++
    }),
    MAX_CONCURRENT_DOWNLOADS
  )

  return { downloaded: toDownload.length - failed, failed }
}
