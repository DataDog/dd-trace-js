import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { mergeCoverageJson, mergeLcov, mergeRunCoverage, planCoverageGroups } from './group-coverage.mjs'

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

    it('keeps unrelated files as separate records, in first-seen order', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      writeFileSync(a, 'SF:a.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n')
      writeFileSync(b, 'SF:b.js\nDA:1,1\nLF:1\nLH:1\nend_of_record') // no trailing newline
      assert.equal(
        mergeLcov([a, b]),
        'SF:a.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' +
        'SF:b.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'
      )
    })

    it('sums DA hit counts for the same file and line across reports', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      writeFileSync(a, 'SF:shared.js\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n')
      writeFileSync(b, 'SF:shared.js\nDA:1,2\nDA:2,3\nLF:2\nLH:2\nend_of_record\n')
      assert.equal(
        mergeLcov([a, b]),
        'SF:shared.js\nDA:1,3\nDA:2,3\nLF:2\nLH:2\nend_of_record\n'
      )
    })

    it('sums FNDA hit counts for the same function across reports', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      writeFileSync(a, 'SF:shared.js\nFN:1,foo\nFNDA:1,foo\nFNF:1\nFNH:1\nend_of_record\n')
      writeFileSync(b, 'SF:shared.js\nFN:1,foo\nFNDA:0,foo\nFNF:1\nFNH:0\nend_of_record\n')
      assert.equal(
        mergeLcov([a, b]),
        'SF:shared.js\nFN:1,foo\nFNDA:1,foo\nFNF:1\nFNH:1\nend_of_record\n'
      )
    })

    it('sums BRDA hit counts for the same branch, treating "-" as an unreached block', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      // First cell never reaches the block (`-`); second cell reaches it but doesn't take branch 1.
      writeFileSync(a, 'SF:shared.js\nBRDA:1,0,0,-\nBRDA:1,0,1,-\nBRF:2\nBRH:0\nend_of_record\n')
      writeFileSync(b, 'SF:shared.js\nBRDA:1,0,0,2\nBRDA:1,0,1,0\nBRF:2\nBRH:1\nend_of_record\n')
      assert.equal(
        mergeLcov([a, b]),
        'SF:shared.js\nBRDA:1,0,0,2\nBRDA:1,0,1,0\nBRF:2\nBRH:1\nend_of_record\n'
      )
    })

    it('merges duplicate SF blocks for the same file into one record instead of two', () => {
      const a = join(dir, 'a.info')
      writeFileSync(
        a,
        'SF:shared.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n' +
        'SF:shared.js\nDA:1,4\nLF:1\nLH:1\nend_of_record\n'
      )
      assert.equal(
        mergeLcov([a]),
        'SF:shared.js\nDA:1,5\nLF:1\nLH:1\nend_of_record\n'
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

    it('sums statement hit counts for the same file across reports', () => {
      const a = join(dir, 'a.json')
      const b = join(dir, 'b.json')
      const statementMap = { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } }
      writeFileSync(a, JSON.stringify({
        'shared.js': { path: 'shared.js', statementMap, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} },
      }))
      writeFileSync(b, JSON.stringify({
        'shared.js': { path: 'shared.js', statementMap, fnMap: {}, branchMap: {}, s: { 0: 2 }, f: {}, b: {} },
      }))
      const merged = mergeCoverageJson([a, b])
      assert.equal(merged['shared.js'].s[0], 3)
    })
  })

  describe('mergeRunCoverage', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'group-coverage-run-'))
    })

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true })
    })

    it('merges the given run\'s lcov cells into <output>/<runId>/lcov/lcov.info', () => {
      const input = join(dir, 'coverage-results')
      const output = join(dir, 'coverage-upload')
      const cellDir = join(input, '42', 'coverage-apm-integrations-axios__a-0', 'node-20-x')
      mkdirSync(cellDir, { recursive: true })
      writeFileSync(join(cellDir, 'lcov.info'), 'SF:a.js\nDA:1,1\nend_of_record\n')

      const { lcovDir, jsonDir } = mergeRunCoverage('42', input, output)

      assert.equal(lcovDir, join(output, '42', 'lcov'))
      assert.equal(jsonDir, null)
      assert.equal(
        readFileSync(join(lcovDir, 'lcov.info'), 'utf8'),
        'SF:a.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'
      )
    })

    it('merges the given run\'s json cells into <output>/<runId>/json/coverage-final.json', () => {
      const input = join(dir, 'coverage-results')
      const output = join(dir, 'coverage-upload')
      const cellDir = join(input, '42', 'coverage-apm-integrations-axios__a-0', 'node-20-x')
      mkdirSync(cellDir, { recursive: true })
      const statementMap = { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } }
      writeFileSync(join(cellDir, 'coverage-final.json'), JSON.stringify({
        'a.js': { path: 'a.js', statementMap, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} },
      }))

      const { lcovDir, jsonDir } = mergeRunCoverage('42', input, output)

      assert.equal(lcovDir, null)
      assert.equal(jsonDir, join(output, '42', 'json'))
      assert.equal(JSON.parse(readFileSync(join(jsonDir, 'coverage-final.json'), 'utf8'))['a.js'].s[0], 1)
    })

    it('returns null for both directories when the run produced no coverage', () => {
      const input = join(dir, 'coverage-results')
      mkdirSync(input, { recursive: true })
      assert.deepEqual(
        mergeRunCoverage('42', input, join(dir, 'coverage-upload')),
        { lcovDir: null, jsonDir: null }
      )
    })

    it('skips the json merge when skipJson is set, but still merges lcov', () => {
      const input = join(dir, 'coverage-results')
      const output = join(dir, 'coverage-upload')
      const cellDir = join(input, '42', 'coverage-apm-integrations-axios__a-0', 'node-20-x')
      mkdirSync(cellDir, { recursive: true })
      writeFileSync(join(cellDir, 'lcov.info'), 'SF:a.js\nDA:1,1\nend_of_record\n')
      writeFileSync(join(cellDir, 'coverage-final.json'), JSON.stringify({}))

      const { lcovDir, jsonDir } = mergeRunCoverage('42', input, output, true)

      assert.equal(lcovDir, join(output, '42', 'lcov'))
      assert.equal(jsonDir, null)
      assert.equal(existsSync(join(output, '42', 'json')), false)
    })

    it('ignores other runs\' cells', () => {
      const input = join(dir, 'coverage-results')
      const otherCellDir = join(input, '7', 'coverage-appsec-express__job-0', 'node-20-x')
      mkdirSync(otherCellDir, { recursive: true })
      writeFileSync(join(otherCellDir, 'lcov.info'), 'SF:b.js\nDA:1,1\nend_of_record\n')

      assert.deepEqual(
        mergeRunCoverage('42', input, join(dir, 'coverage-upload')),
        { lcovDir: null, jsonDir: null }
      )
      assert.equal(existsSync(join(dir, 'coverage-upload', '42')), false)
    })
  })
})
