import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { mergeLcov, planCoverageGroups } from './group-coverage.mjs'

/**
 * One cell's discovered report set: one `lcov` entry per Node.js version the cell ran.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.versions]  Number of Node.js versions the cell ran (one report each).
 * @returns {Array<{ runId: string, name: string, format: string, reportPath: string }>}
 */
function files (name, { runId = '1', versions = 1 } = {}) {
  const out = []
  for (let version = 0; version < versions; version++) {
    const dir = `coverage-results/${runId}/${name}/node-2${version}-x`
    out.push({ runId, name, format: 'lcov', reportPath: `${dir}/lcov.info` })
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

    it('keeps a report per Node.js version a single artifact carries', () => {
      const { reportsByArtifact } = planCoverageGroups(files('coverage-apm-integrations-axios__a-0', { versions: 2 }))
      const reports = reportsByArtifact.get('coverage-apm-integrations-axios__a-0')
      assert.equal(reports.filter(report => report.format === 'lcov').length, 2)
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

  describe('mergeLcov', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'group-coverage-lcov-'))
    })

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true })
    })

    it('concatenates every report, adding a trailing newline when one is missing', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      writeFileSync(a, 'SF:a.js\nDA:1,1\nend_of_record\n')
      writeFileSync(b, 'SF:b.js\nDA:1,1\nend_of_record') // no trailing newline
      assert.equal(
        mergeLcov([a, b]),
        'SF:a.js\nDA:1,1\nend_of_record\nSF:b.js\nDA:1,1\nend_of_record\n'
      )
    })
  })
})
