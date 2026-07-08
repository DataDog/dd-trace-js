import { mkdirSync, unlinkSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

/* eslint-disable no-console */

const execFileAsync = promisify(execFile)

/**
 * @param {import('octokit').Octokit} octokit
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.token
 * @param {Array<{id: number}>} opts.runs
 * @returns {Promise<{ downloaded: number, failed: number }>}
 */
export async function downloadArtifacts (octokit, { owner, repo, token, runs }) {
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
  await Promise.all(toDownload.map(async ({ runId, artifact }) => {
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
    } catch (err) {
      failed++
      console.error(`Failed to download ${artifact.name} from run ${runId}: ${err.message}`)
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }
  }))

  return { downloaded: toDownload.length - failed, failed }
}
