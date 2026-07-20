import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runUpload } from './run-upload.mjs'

/**
 * Upload one workflow run's downloaded junit reports to Datadog, if it produced any.
 *
 * @param {{ id: number, name: string }} run
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadJunit (run) {
  const junitDir = join('junit-results', String(run.id))
  if (!existsSync(junitDir)) return []

  const result = await runUpload('datadog-ci',
    ['junit', 'upload', '--service', 'dd-trace-js-tests', '--auto-discovery', junitDir])
  return [result]
}
