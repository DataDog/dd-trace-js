import { mergeRunCoverage } from './group-coverage.mjs'
import { logUploads, runUpload, runUploadWithRetry } from './run-upload.mjs'

/**
 * @param {{ sha: string, branch: string, prNumber?: string }} options
 * @returns {string[]}
 */
function codecovCommitArgs ({ sha, branch, prNumber }) {
  const args = ['create-commit', '--sha', sha, '--branch', branch, '--fail-on-error']
  if (prNumber) args.push('--pr', prNumber)
  return args
}

/**
 * @param {string} sha
 * @returns {string[]}
 */
function codecovReportArgs (sha) {
  return ['create-report', '--sha', sha, '--fail-on-error']
}

/**
 * @param {string} coverageDir
 * @param {{ sha: string, prNumber?: string, eventName: string, baseRef: string }} options
 * @returns {string[]}
 */
function codecovUploadArgs (coverageDir, { sha, prNumber, eventName, baseRef }) {
  const args = ['do-upload', '--sha', sha, '--dir', coverageDir, '-F', 'coverage', '--fail-on-error']
  if (prNumber) args.push('--pr', prNumber)
  // `master-coverage` is the flag `.codecov.yml` gates `codecov/patch` on; attach it only on PRs
  // targeting master so release-branch PRs auto-pass.
  if (eventName === 'pull_request' && baseRef === 'master') args.push('-F', 'master-coverage')
  return args
}

// `do-upload` requires the commit and report to already exist in Codecov, and every sibling
// workflow's coverage upload needs the same one, so this is memoized instead of registered per run.
let commitAndReport

/**
 * @param {{ sha: string, branch: string, prNumber?: string }} options
 * @returns {Promise<boolean>} whether both calls succeeded
 */
function ensureCodecovCommit (options) {
  commitAndReport ??= (async () => {
    const results = [
      await runUploadWithRetry('codecovcli', codecovCommitArgs(options)),
      await runUploadWithRetry('codecovcli', codecovReportArgs(options.sha)),
    ]
    logUploads('codecov-setup', results)
    return results.every(result => result.code === 0)
  })()
  return commitAndReport
}

/**
 * @returns {boolean} whether any run has registered a Codecov commit/report for this ref. False
 * on Dependabot PRs, whose coverage artifacts are skipped, so no run ever calls `uploadCoverage`
 * with a non-empty coverage dir.
 */
export function hasCodecovCommit () {
  return commitAndReport !== undefined
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
export async function uploadCoverage (run, options) {
  const coverageDir = mergeRunCoverage(run.id)
  if (!coverageDir) return []

  const datadogUpload = runUpload('datadog-ci', ['coverage', 'upload', coverageDir, '--flags', 'coverage'])
  const commitReady = await ensureCodecovCommit(options)
  const codecovUpload = commitReady
    ? runUploadWithRetry('codecovcli', codecovUploadArgs(coverageDir, options))
    : null

  const results = await Promise.all([datadogUpload, codecovUpload])
  return results.filter(Boolean)
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
  return runUploadWithRetry('codecovcli', ['send-notifications', '--sha', sha, '--fail-on-error'])
}
