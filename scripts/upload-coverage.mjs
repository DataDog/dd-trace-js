import { existsSync } from 'node:fs'
import { OUTPUT_DIR, mergeRunCoverage } from './group-coverage.mjs'
import { logUploads, runUpload, runUploadWithRetry } from './run-upload.mjs'

// Codecov validates flags against `^[\w\.\-]{1,45}$` and silently drops any that fail.
const MAX_FLAG_LENGTH = 45

/**
 * The Codecov flag for one sibling workflow's upload, so each workflow's coverage is
 * distinguishable in Codecov's per-flag breakdown instead of every upload sharing one flag.
 *
 * @param {string} workflowName
 * @returns {string}
 */
function flagOf (workflowName) {
  return workflowName
    .toLowerCase()
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_FLAG_LENGTH)
}

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
 * @param {string} flag
 * @param {{ sha: string, prNumber?: string, eventName: string, baseRef: string }} options
 * @returns {string[]}
 */
function codecovUploadArgs (coverageDir, flag, { sha, prNumber, eventName, baseRef }) {
  const args = ['do-upload', '--sha', sha, '--dir', coverageDir, '-F', flag, '--fail-on-error']
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
 * Merge one workflow run's coverage and upload it to Codecov, if it produced any. The upload carries
 * a flag derived from the workflow's name (see `flagOf`) so Codecov's per-flag breakdown reflects
 * each sibling workflow separately instead of every upload sharing one flag; that per-run flag is
 * also why this stays one upload per workflow run instead of batching like the Datadog upload does
 * (see `uploadAllCoverageToDatadog`) — merging lcov files that came from cells with the same content
 * is safe, but merging Codecov uploads that each need a different flag isn't.
 *
 * @param {{ id: number, name: string }} run
 * @param {{ sha: string, branch: string, prNumber?: string, eventName: string, baseRef: string }} options
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadCoverage (run, options) {
  const { lcovDir } = mergeRunCoverage(run.id)
  if (!lcovDir) return []

  const commitReady = await ensureCodecovCommit(options)
  if (!commitReady) return []

  const result = await runUploadWithRetry('codecovcli', codecovUploadArgs(lcovDir, flagOf(run.name), options))
  return [result]
}

/**
 * Upload every sibling workflow's already-per-run-merged lcov file to Datadog in a single call,
 * instead of uploading each workflow run's coverage separately — Datadog's coverage flag doesn't
 * vary per run, so nothing needs the per-run separation Codecov's flags require (see
 * `uploadCoverage`). `datadog-ci coverage upload` recursively discovers every report file under a
 * given path by default, so there's no need to merge every run's lcov file into one document first,
 * the way junit upload used to (see `upload-junit.mjs`).
 *
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadAllCoverageToDatadog () {
  if (!existsSync(OUTPUT_DIR)) return []

  const result = await runUpload('datadog-ci', ['coverage', 'upload', OUTPUT_DIR, '--flags', 'coverage'])
  return [result]
}

/**
 * @param {object} options
 * @param {boolean} options.isGitHubActions
 * @param {number} options.failedRunCount
 * @param {boolean} options.uploadFailed
 * @param {boolean} options.processingFailed
 * @param {boolean} options.hasCommit
 * @returns {boolean}
 */
export function shouldNotifyCodecov ({
  isGitHubActions, failedRunCount, uploadFailed, processingFailed, hasCommit,
}) {
  return isGitHubActions && failedRunCount === 0 && !uploadFailed && !processingFailed && hasCommit
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

export { codecovUploadArgs, flagOf }
