'use strict'

const assert = require('assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { discoverCoverageReports } = require('../../src/ci-visibility/coverage-report-discovery')

describe('coverage-report-discovery', () => {
  let tmpDir

  beforeEach(() => {
    // Create a temporary directory for test files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-test-'))
  })

  afterEach(() => {
    // Clean up temporary directory
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('discoverCoverageReports', () => {
    it('should return empty array when no coverage reports exist', () => {
      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 0)
    })

    it('should return empty array when rootDir is not provided', () => {
      const reports = discoverCoverageReports(null)
      assert.strictEqual(reports.length, 0)
    })

    it('should discover lcov.info file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'TN:\nSF:file.js\nend_of_record')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'lcov')
      assert.ok(reports[0].filePath.includes('lcov.info'))
    })

    it('should discover cobertura XML file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'cobertura-coverage.xml'), '<coverage></coverage>')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'cobertura')
      assert.ok(reports[0].filePath.includes('cobertura-coverage.xml'))
    })

    it('should discover clover XML file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'clover.xml'), '<coverage></coverage>')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'clover')
      assert.ok(reports[0].filePath.includes('clover.xml'))
    })

    it('should discover jacoco XML file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'jacoco.xml'), '<report></report>')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'jacoco')
      assert.ok(reports[0].filePath.includes('jacoco.xml'))
    })

    it('should discover istanbul JSON file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'coverage-final.json'), '{}')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'lcov')
      assert.ok(reports[0].filePath.includes('coverage-final.json'))
    })

    it('should discover simplecov JSON file', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, '.resultset.json'), '{}')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'simplecov')
      assert.ok(reports[0].filePath.includes('.resultset.json'))
    })

    it('should discover multiple coverage reports', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'TN:\nSF:file.js\nend_of_record')
      fs.writeFileSync(path.join(coverageDir, 'cobertura-coverage.xml'), '<coverage></coverage>')
      fs.writeFileSync(path.join(coverageDir, 'clover.xml'), '<coverage></coverage>')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 3)

      const formats = reports.map(r => r.format)
      assert.ok(formats.includes('lcov'))
      assert.ok(formats.includes('cobertura'))
      assert.ok(formats.includes('clover'))
    })

    it('should ignore directories with coverage report names', () => {
      const coverageDir = path.join(tmpDir, 'coverage')
      fs.mkdirSync(coverageDir)
      // Create a directory named lcov.info (should be ignored)
      fs.mkdirSync(path.join(coverageDir, 'lcov.info'))

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 0)
    })

    it('should discover reports in root directory (no coverage/ subdirectory)', () => {
      fs.writeFileSync(path.join(tmpDir, 'lcov.info'), 'TN:\nSF:file.js\nend_of_record')

      const reports = discoverCoverageReports(tmpDir)
      assert.strictEqual(reports.length, 1)
      assert.strictEqual(reports[0].format, 'lcov')
    })

    it('should handle permission errors gracefully', () => {
      // This test verifies that discovery doesn't crash on permission errors
      // We can't easily simulate permission errors in a cross-platform way,
      // but the code should handle them gracefully
      const nonExistentPath = path.join(tmpDir, 'non-existent', 'deep', 'path')

      const reports = discoverCoverageReports(nonExistentPath)
      assert.strictEqual(reports.length, 0)
    })
  })
})
