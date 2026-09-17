import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { mergeLcov, mergeRunCoverage } from './group-coverage.mjs'

describe('group-coverage', () => {
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

    it('keeps same-named functions declared at different lines distinct', () => {
      const a = join(dir, 'a.info')
      writeFileSync(
        a,
        'SF:shared.js\nFN:4,shared\nFN:9,shared\nFNF:2\nFNDA:2,shared\nFNDA:0,shared\nFNH:1\nend_of_record\n'
      )
      assert.equal(
        mergeLcov([a]),
        'SF:shared.js\nFN:4,shared\nFN:9,shared\nFNDA:2,shared\nFNDA:0,shared\nFNF:2\nFNH:1\nend_of_record\n'
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

    it('merges the same file across a Windows and a POSIX cell instead of splitting the record', () => {
      const a = join(dir, 'a.info')
      const b = join(dir, 'b.info')
      writeFileSync(a, 'SF:packages\\dd-trace\\src\\shared.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n')
      writeFileSync(b, 'SF:packages/dd-trace/src/shared.js\nDA:1,2\nLF:1\nLH:1\nend_of_record\n')
      assert.equal(
        mergeLcov([a, b]),
        'SF:packages/dd-trace/src/shared.js\nDA:1,3\nLF:1\nLH:1\nend_of_record\n'
      )
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
      const firstCellDir = join(input, '42', 'coverage-apm-integrations-axios__a-0', 'node-20-x')
      const secondVersionDir = join(input, '42', 'coverage-apm-integrations-axios__a-0', 'node-22-x')
      const secondCellDir = join(input, '42', 'coverage-appsec-express__job-0', 'node-22-x')
      const unrelatedDir = join(input, '42', 'download-metadata', 'node-22-x')
      mkdirSync(firstCellDir, { recursive: true })
      mkdirSync(secondVersionDir, { recursive: true })
      mkdirSync(secondCellDir, { recursive: true })
      mkdirSync(unrelatedDir, { recursive: true })
      writeFileSync(join(firstCellDir, 'lcov.info'), 'SF:a.js\nDA:1,1\nend_of_record\n')
      writeFileSync(join(secondVersionDir, 'lcov.info'), 'SF:a.js\nDA:1,2\nend_of_record\n')
      writeFileSync(join(secondCellDir, 'lcov.info'), 'SF:b.js\nDA:1,1\nend_of_record\n')
      writeFileSync(join(unrelatedDir, 'lcov.info'), 'SF:ignored.js\nDA:1,1\nend_of_record\n')

      const { lcovDir } = mergeRunCoverage('42', input, output)

      assert.equal(lcovDir, join(output, '42', 'lcov'))
      assert.equal(
        readFileSync(join(lcovDir, 'lcov.info'), 'utf8'),
        'SF:a.js\nDA:1,3\nLF:1\nLH:1\nend_of_record\n' +
        'SF:b.js\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'
      )
    })

    it('returns null when the run produced no coverage', () => {
      const input = join(dir, 'coverage-results')
      mkdirSync(input, { recursive: true })
      assert.deepEqual(
        mergeRunCoverage('42', input, join(dir, 'coverage-upload')),
        { lcovDir: null }
      )
    })

    it('ignores other runs\' cells', () => {
      const input = join(dir, 'coverage-results')
      const otherCellDir = join(input, '7', 'coverage-appsec-express__job-0', 'node-20-x')
      mkdirSync(otherCellDir, { recursive: true })
      writeFileSync(join(otherCellDir, 'lcov.info'), 'SF:b.js\nDA:1,1\nend_of_record\n')

      assert.deepEqual(
        mergeRunCoverage('42', input, join(dir, 'coverage-upload')),
        { lcovDir: null }
      )
      assert.equal(existsSync(join(dir, 'coverage-upload', '42')), false)
    })
  })
})
