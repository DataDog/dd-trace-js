import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runUpload } from './run-upload.mjs'

// One sibling workflow's upload bundles every matrix cell's (e.g. per-Node-version) junit XML
// together, so a per-test tag is the only way to tell which cell a result came from — the CI job
// name/ID tags datadog-ci attaches are the same for every file in one upload call.
// `.mochamultireporterrc.js` stamps each testsuite with a `node_version` property; this lifts it
// into a real tag using the xpath pattern datadog-ci documents for `<property>` extraction.
const NODE_VERSION_XPATH_TAG = "test.node_version=/testcase/..//property[@name='node_version']/@value"

/**
 * Upload one workflow run's downloaded junit reports to Datadog, if it produced any.
 *
 * @param {{ id: number, name: string }} run
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadJunit (run) {
  const junitDir = join('junit-results', String(run.id))
  if (!existsSync(junitDir)) return []

  const result = await runUpload('datadog-ci', [
    'junit', 'upload', '--service', 'dd-trace-js-tests', '--auto-discovery', junitDir,
    '--xpath-tag', NODE_VERSION_XPATH_TAG,
  ])
  return [result]
}
