'use strict'

const env = process.env // eslint-disable-line eslint-rules/eslint-process-env
const isCI = Boolean(env.CI)

const reporterEnabled = ['spec']
if (isCI) reporterEnabled.push('./scripts/junit-reporter.js')

// datadog-ci junit upload derives the Pipeline/Job UI facets from GITHUB_* env vars in its own
// process at upload time, which are All Green's own since it uploads every sibling workflow's
// results in a single call. Stamping them here instead, while this job's own GITHUB_* values are
// still correct, lets `--xpath-tag` (see scripts/upload-junit.mjs) remap them onto the real
// ci.pipeline.*/ci.job.* tags per test instead.
const {
  GITHUB_JOB, GITHUB_RUN_ID, GITHUB_WORKFLOW, GITHUB_RUN_NUMBER, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
} = env

module.exports = {
  reporterEnabled,
  scriptsJunitReporterJsReporterOptions: {
    mochaFile: `./node-${process.versions.node}-junit.xml`,
    properties: {
      node_version: process.versions.node,
      ...(isCI && {
        'ci.pipeline.name': GITHUB_WORKFLOW,
        'ci.pipeline.id': GITHUB_RUN_ID,
        'ci.pipeline.number': GITHUB_RUN_NUMBER,
        'ci.pipeline.url': `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
        'ci.job.name': GITHUB_JOB,
      }),
    },
  },
}
