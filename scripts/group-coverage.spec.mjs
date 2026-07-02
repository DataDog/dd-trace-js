import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { areaOf, flagOf, planCoverageGroups } from './group-coverage.mjs'

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
  describe('areaOf', () => {
    it('matches a single-token area', () => {
      assert.equal(areaOf('appsec-windows'), 'appsec')
      assert.equal(areaOf('appsec'), 'appsec')
    })

    it('matches a compound area before its shorter prefix would', () => {
      assert.equal(areaOf('apm-integrations-kafkajs-18'), 'apm-integrations')
      assert.equal(areaOf('apm-capabilities-tracing-macos'), 'apm-capabilities')
    })

    it('matches test-optimization regardless of the tail', () => {
      assert.equal(areaOf('test-optimization-cypress-latest-14.5.4-esm'), 'test-optimization')
      assert.equal(areaOf('test-optimization-mocha-oldest-10.0.0'), 'test-optimization')
    })

    it('falls back to the first token for an unrecognized flag', () => {
      assert.equal(areaOf('unknown-thing-here'), 'unknown')
      assert.equal(areaOf('latest'), 'latest')
    })
  })

  describe('flagOf', () => {
    it('drops the coverage- prefix', () => {
      assert.equal(flagOf('coverage-appsec-express'), 'appsec-express')
    })

    it('drops the per-cell uniqueness suffix after the separator', () => {
      assert.equal(flagOf('coverage-test-optimization-cypress-latest-14.5.4-esm__integration-cypress-7'),
        'test-optimization-cypress-latest-14.5.4-esm')
    })
  })

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

    it('folds cells that share a flag but carry distinct uniqueness suffixes into one area', () => {
      // Cypress varies `spec` outside its flag: eight specs per (version, cypress-version, module)
      // upload distinct artifacts that all belong to the one test-optimization area.
      const { cellsByArea } = planCoverageGroups([
        ...files('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-0'),
        ...files('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-1'),
      ])
      assert.deepEqual([...cellsByArea.keys()], ['test-optimization'])
      assert.equal(cellsByArea.get('test-optimization').length, 2)
    })

    it('folds distinct integrations under the same area', () => {
      const { cellsByArea } = planCoverageGroups([
        ...files('coverage-apm-integrations-next-11.1.4__integration-next-0'),
        ...files('coverage-apm-integrations-kafkajs-18__integration-kafkajs-0'),
      ])
      assert.deepEqual([...cellsByArea.keys()], ['apm-integrations'])
      assert.equal(cellsByArea.get('apm-integrations').length, 2)
    })

    it('keeps an unrecognized area in its own group instead of dropping it', () => {
      const { cellsByArea } = planCoverageGroups(files('coverage-mystery-flag__job-0'))
      assert.deepEqual([...cellsByArea.keys()], ['mystery'])
    })
  })
})
