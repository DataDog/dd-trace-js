import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runUpload } from './run-upload.mjs'

/**
 * Upload one workflow run's downloaded junit reports to Datadog, if it produced any.
 *
 * @param {{ id: number, name: string }} run
 * @returns {Promise<void>}
 */
export async function uploadJunit (run) {
  const junitDir = join('junit-results', String(run.id))
  if (!existsSync(junitDir)) return

  await runUpload(run.name, 'datadog-ci',
    ['junit', 'upload', '--service', 'dd-trace-js-tests', '--auto-discovery', junitDir])
}
