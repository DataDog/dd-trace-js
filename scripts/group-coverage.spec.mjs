import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { planCoverageGroups } from './group-coverage.mjs'

/**
 * One cell's discovered report set: a `lcov` and a `json` entry per Node.js version the cell ran.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.versions]  Number of Node.js versions the cell ran (one report set each).
 * @returns {Array<{ runId: string, name: string, format: string, reportPath: string }>}
 */
function files (name, { runId = '1', versions = 1 } = {}) {
  const out = []
  for (let version = 0; version < versions; version++) {
    const dir = `coverage-results/${runId}/${name}/node-2${version}-x`
    out.push(
      { runId, name, format: 'lcov', reportPath: `${dir}/lcov.info` },
      { runId, name, format: 'json', reportPath: `${dir}/coverage-final.json` }
    )
  }
  return out
}

describe('group-coverage', () => {
  describe('planCoverageGroups', () => {
    it('keeps only the newest run when a rerun reuploads the same artifact name', () => {
      const { reportsByArtifact } = planCoverageGroups([
        ...files('coverage-apm-integrations-axios__a-0', { runId: '100' }),
        ...files('coverage-apm-integrations-axios__a-0', { runId: '205' }),
      ])
      const reports = reportsByArtifact.get('coverage-apm-integrations-axios__a-0')
      assert.ok(reports.every(report => report.reportPath.includes('/205/')), 'only the newest run survives')
    })

    it('compares run ids numerically across a digit-length boundary', () => {
      // A lexicographic compare keeps the older run when the rerun crosses a power-of-ten boundary
      // (`'9' > '10'` is true as strings), silently uploading the stale failed run's coverage.
      const { reportsByArtifact } = planCoverageGroups([
        ...files('coverage-apm-integrations-axios__a-0', { runId: '9' }),
        ...files('coverage-apm-integrations-axios__a-0', { runId: '10' }),
      ])
      const reports = reportsByArtifact.get('coverage-apm-integrations-axios__a-0')
      assert.ok(reports.every(report => report.reportPath.includes('/10/')), 'the newer run wins numerically')
    })

    it('keeps both formats across every Node.js version a single artifact carries', () => {
      const { reportsByArtifact } = planCoverageGroups(files('coverage-apm-integrations-axios__a-0', { versions: 2 }))
      const reports = reportsByArtifact.get('coverage-apm-integrations-axios__a-0')
      assert.equal(reports.filter(report => report.format === 'lcov').length, 2)
      assert.equal(reports.filter(report => report.format === 'json').length, 2)
    })

    it('folds every cell into the same single group regardless of flag', () => {
      const { artifacts } = planCoverageGroups([
        ...files('coverage-apm-integrations-next-11.1.4__integration-next-0'),
        ...files('coverage-appsec-express__job-0'),
        ...files('coverage-mystery-flag__job-0'),
      ])
      assert.deepEqual(artifacts, [
        'coverage-apm-integrations-next-11.1.4__integration-next-0',
        'coverage-appsec-express__job-0',
        'coverage-mystery-flag__job-0',
      ])
    })
  })
})
