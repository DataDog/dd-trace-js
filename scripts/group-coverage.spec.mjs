import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { mergeCoverageJson, mergeLcov, planCoverageGroups } from './group-coverage.mjs'

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

/**
 * A minimal valid istanbul FileCoverage entry for one statement, so `mergeCoverageJson` has a
 * realistic shape to merge.
 *
 * @param {string} filePath
 * @param {number} count
 * @returns {object}
 */
function fileCoverage (filePath, count) {
  return {
    [filePath]: {
      path: filePath,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: count },
      f: {},
      b: {},
    },
  }
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

  describe('mergeCoverageJson', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'group-coverage-json-'))
    })

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true })
    })

    it('sums hit counts for a file shared across cells instead of overwriting them', () => {
      const a = join(dir, 'a.json')
      const b = join(dir, 'b.json')
      writeFileSync(a, JSON.stringify(fileCoverage('/shared.js', 2)))
      writeFileSync(b, JSON.stringify(fileCoverage('/shared.js', 3)))
      const merged = mergeCoverageJson([a, b])
      assert.equal(merged['/shared.js'].s[0], 5)
    })

    it('keeps files that only appear in one report', () => {
      const a = join(dir, 'a.json')
      const b = join(dir, 'b.json')
      writeFileSync(a, JSON.stringify(fileCoverage('/only-a.js', 1)))
      writeFileSync(b, JSON.stringify(fileCoverage('/only-b.js', 1)))
      const merged = mergeCoverageJson([a, b])
      assert.deepEqual(Object.keys(merged).sort(), ['/only-a.js', '/only-b.js'])
    })
  })
})
