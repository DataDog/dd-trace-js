import { mergeRunCoverage } from './group-coverage.mjs'
import { runUpload } from './run-upload.mjs'

/**
 * @param {string} coverageDir
 * @param {{ sha: string, branch: string, prNumber?: string, eventName: string, baseRef: string }} options
 * @returns {string[]}
 */
function codecovUploadArgs (coverageDir, { sha, branch, prNumber, eventName, baseRef }) {
  const args = ['do-upload', '--sha', sha, '--branch', branch, '--dir', coverageDir, '-F', 'coverage']
  if (prNumber) args.push('--pr', prNumber)
  // `master-coverage` is the flag `.codecov.yml` gates `codecov/patch` on; attach it only on PRs
  // targeting master so release-branch PRs auto-pass.
  if (eventName === 'pull_request' && baseRef === 'master') args.push('-F', 'master-coverage')
  return args
}

/**
 * Merge and upload one workflow run's coverage to Datadog and Codecov, if it produced any. Only
 * lcov is uploaded: both backends read it, and this repo's `patch-istanbul-lib-coverage.js`
 * already folds branch/function hit data into lcov's `DA:` records, so no separate istanbul JSON
 * report is needed for either backend's coverage gate.
 *
 * @param {{ id: number, name: string }} run
 * @param {{ sha: string, branch: string, prNumber?: string, eventName: string, baseRef: string }} options
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export function uploadCoverage (run, options) {
  const coverageDir = mergeRunCoverage(run.id)
  if (!coverageDir) return []

  return Promise.all([
    runUpload('datadog-ci', ['coverage', 'upload', coverageDir, '--flags', 'coverage']),
    runUpload('codecovcli', codecovUploadArgs(coverageDir, options)),
  ])
}

/**
 * Trigger Codecov to compute and post its coverage status for a commit. `.codecov.yml` sets
 * `codecov.notify.manual_trigger`, since coverage lands one sibling workflow at a time rather than
 * all at once — without it, Codecov would post its status after the first upload it sees, before
 * the rest have arrived.
 *
 * @param {string} sha
 * @returns {Promise<import('./run-upload.mjs').UploadResult>}
 */
export function sendCodecovNotifications (sha) {
  return runUpload('codecovcli', ['send-notifications', '--sha', sha])
}
