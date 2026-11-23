import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { runUpload } from './run-upload.mjs'
import { Semaphore } from './semaphore.mjs'

const INPUT_DIR = 'junit-results'
const MAX_CONCURRENT_UPLOADS = 4
const RUN_ATTEMPT_PROPERTY = /<property name="GITHUB_RUN_ATTEMPT" value="(\d+)"/

// Every sibling workflow's upload is merged into one call, so datadog-ci's own GITHUB_*-derived
// Pipeline/Job tags would attribute every test to the All Green workflow instead of the one that
// produced it. `.mochamultireporterrc.js` stamps each testsuite with its own job's CI metadata (plus
// `node_version`) as XML properties at mocha-run time, while that job's own GITHUB_* env vars are
// still correct; these xpath-tag mappings lift those properties into real per-test tags at upload
// time, using the same reserved `ci.*` tag names datadog-ci's own GitHub Actions detection populates.
const XPATH_TAGS = [
  "test.node_version=/testcase/..//property[@name='node_version']/@value",
  "ci.pipeline.name=/testcase/..//property[@name='ci.pipeline.name']/@value",
  "ci.pipeline.id=/testcase/..//property[@name='ci.pipeline.id']/@value",
  "ci.pipeline.number=/testcase/..//property[@name='ci.pipeline.number']/@value",
  "ci.pipeline.url=/testcase/..//property[@name='ci.pipeline.url']/@value",
  "ci.job.name=/testcase/..//property[@name='ci.job.name']/@value",
]

// datadog-ci derives ci.pipeline.*/ci.job.* tags from these GITHUB_* variables, which are All Green's
// own here and would overwrite the per-test XPATH_TAGS values above. JOB_CHECK_RUN_ID is All Green's
// job id, so it would point the uploaded tests at a job that did not run them.
const NO_PIPELINE_ATTRIBUTION_ENV = {
  GITHUB_WORKFLOW: '',
  GITHUB_JOB: '',
  GITHUB_RUN_ID: '',
  GITHUB_RUN_NUMBER: '',
  JOB_CHECK_RUN_ID: '',
}

const uploadSemaphore = new Semaphore(MAX_CONCURRENT_UPLOADS)

/**
 * @param {string} file
 */
function isJunitReport (file) {
  const name = basename(file)
  return name.endsWith('.xml') && (name.includes('junit') || name.includes('test') || name.includes('TEST-'))
}

/**
 * Group the downloaded reports under `junit-results/<run-id>/` by the run attempt stamped into
 * each report, so each group can be uploaded with its own run's GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT.
 * Datadog derives the pipeline correlation id from those two values; without it, the tests can't
 * be linked to the pipeline that ran them.
 *
 * @param {string} inputDir
 * @returns {Array<{ runId: string, runAttempt: string | undefined, files: string[] }>}
 */
export function groupJunitReports (inputDir) {
  const groups = new Map()
  for (const runId of readdirSync(inputDir)) {
    const runDir = join(inputDir, runId)
    for (const file of readdirSync(runDir, { recursive: true })) {
      if (!isJunitReport(file)) continue
      const path = join(runDir, file)
      const runAttempt = readFileSync(path, 'utf8').match(RUN_ATTEMPT_PROPERTY)?.[1]
      const key = `${runId}/${runAttempt}`
      let group = groups.get(key)
      if (!group) {
        group = { runId, runAttempt, files: [] }
        groups.set(key, group)
      }
      group.files.push(path)
    }
  }
  return [...groups.values()]
}

/**
 * Reports without a stamped run attempt (e.g. from before it was stamped) keep the old
 * unattributed upload.
 *
 * @param {{ runId: string, runAttempt: string | undefined }} group
 * @returns {Record<string, string>}
 */
export function junitUploadEnv ({ runId, runAttempt }) {
  if (!runAttempt) return NO_PIPELINE_ATTRIBUTION_ENV
  return { ...NO_PIPELINE_ATTRIBUTION_ENV, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt }
}

/**
 * Upload every sibling workflow's downloaded junit reports to Datadog, one call per run attempt.
 *
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadAllJunit () {
  if (!existsSync(INPUT_DIR)) return []

  return Promise.all(groupJunitReports(INPUT_DIR).map(async group => {
    await uploadSemaphore.acquire()
    try {
      return await runUpload('datadog-ci', [
        'junit', 'upload', '--service', 'dd-trace-js-tests',
        ...XPATH_TAGS.flatMap(tag => ['--xpath-tag', tag]),
        ...group.files,
      ], junitUploadEnv(group))
    } finally {
      uploadSemaphore.release()
    }
  }))
}
