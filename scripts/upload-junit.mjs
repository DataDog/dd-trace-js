import { existsSync } from 'node:fs'
import { runUpload } from './run-upload.mjs'

const INPUT_DIR = 'junit-results'

// Every sibling workflow's upload is merged into one call, so datadog-ci's own GITHUB_*-derived
// Pipeline/Job facets would attribute every test to the All Green workflow instead of the one that
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

/**
 * Upload every sibling workflow's downloaded junit reports to Datadog in a single call.
 * `--auto-discovery` already walks `junit-results/<run-id>/<artifact-name>/*.xml` recursively and
 * uploads every matching file itself (with its own internal concurrency), so there's no need to
 * merge the reports into one document first — each testcase's `node_version` and `ci.*` properties
 * (see `XPATH_TAGS`) keep matrix cells and originating workflows distinguishable regardless of which
 * file they came from.
 *
 * @returns {Promise<import('./run-upload.mjs').UploadResult[]>}
 */
export async function uploadAllJunit () {
  if (!existsSync(INPUT_DIR)) return []

  const result = await runUpload('datadog-ci', [
    'junit', 'upload', '--service', 'dd-trace-js-tests', '--auto-discovery', INPUT_DIR,
    ...XPATH_TAGS.flatMap(tag => ['--xpath-tag', tag]),
  ])
  return [result]
}
