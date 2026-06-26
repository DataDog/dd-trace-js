import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { flagOf, integrationOf, planCoverageGroups, planGroups } from './group-coverage.mjs'

/**
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.lcovCount]  Number of per-Node-version lcov files the artifact carries.
 * @returns {Array<{ runId: string, name: string, lcovPath: string }>}
 */
function files (name, { runId = '1', lcovCount = 1 } = {}) {
  return Array.from({ length: lcovCount }, (_, index) => ({
    runId,
    name,
    lcovPath: `coverage-results/${runId}/${name}/node-2${index}-x/lcov.info`,
  }))
}

describe('group-coverage', () => {
  describe('integrationOf', () => {
    it('strips a Node.js major from the tail', () => {
      assert.equal(integrationOf('apm-integrations-kafkajs-18'), 'apm-integrations-kafkajs')
    })

    it('strips a library version and its range qualifier', () => {
      assert.equal(integrationOf('apm-integrations-aerospike-20-gte.5.2.0'), 'apm-integrations-aerospike')
    })

    it('strips Node.js tier, library version, and module format together', () => {
      assert.equal(integrationOf('test-optimization-cypress-latest-14.5.4-esm'), 'test-optimization-cypress')
      assert.equal(integrationOf('test-optimization-cypress-oldest-12.0.0-commonJS'), 'test-optimization-cypress')
    })

    it('strips a trailing OS token', () => {
      assert.equal(integrationOf('appsec-windows'), 'appsec')
    })

    it('keeps an integration that carries no version axis', () => {
      assert.equal(integrationOf('apm-integrations-dns'), 'apm-integrations-dns')
    })

    it('strips a Node.js tier stranded mid-flag while keeping the meaningful sub-suite', () => {
      // `serverless-aws-sdk-${node-version}-${spec}`: the tier (oldest/latest) is noise, but the
      // sub-suite (s3, dynamodb) names a real slice of the aws-sdk integration worth its own group.
      assert.equal(integrationOf('serverless-aws-sdk-oldest-s3'), 'serverless-aws-sdk-s3')
      assert.equal(integrationOf('serverless-aws-sdk-latest-dynamodb'), 'serverless-aws-sdk-dynamodb')
    })

    it('never strips the area when every token looks like noise', () => {
      assert.equal(integrationOf('latest'), 'latest')
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

  describe('planGroups', () => {
    it('keeps a multi-cell integration as its own group', () => {
      const groups = planGroups(new Map([['apm-integrations-next', ['a', 'b', 'c']]]))
      assert.deepEqual([...groups], [['apm-integrations-next', ['apm-integrations-next']]])
    })

    it('leaves a small singleton tail (<=2) standalone', () => {
      const groups = planGroups(new Map([
        ['serverless-lambda', ['a']],
        ['serverless-azure', ['b']],
      ]))
      assert.deepEqual(groups.get('serverless-lambda'), ['serverless-lambda'])
      assert.deepEqual(groups.get('serverless-azure'), ['serverless-azure'])
    })

    it('buckets a busy singleton tail into library-named groups of at most three', () => {
      const singletons = ['plugins-axios', 'plugins-redis', 'plugins-pino', 'plugins-fs', 'plugins-net']
      const groups = planGroups(new Map(singletons.map(name => [name, ['cell']])))
      assert.deepEqual([...groups.keys()].sort(), ['plugins-axios+fs+net', 'plugins-pino+redis'])
      assert.deepEqual(groups.get('plugins-axios+fs+net'), ['plugins-axios', 'plugins-fs', 'plugins-net'])
      for (const integrations of groups.values()) {
        assert.ok(integrations.length <= 3, 'no bucket exceeds three integrations')
      }
    })
  })

  describe('planCoverageGroups', () => {
    it('keeps only the newest run when a rerun reuploads the same artifact name', () => {
      const { lcovPathsByArtifact } = planCoverageGroups([
        ...files('coverage-plugins-axios__a-0', { runId: '100' }),
        ...files('coverage-plugins-axios__a-0', { runId: '205' }),
      ])
      assert.deepEqual(lcovPathsByArtifact.get('coverage-plugins-axios__a-0'),
        ['coverage-results/205/coverage-plugins-axios__a-0/node-20-x/lcov.info'])
    })

    it('keeps every per-Node-version lcov a single artifact carries', () => {
      const { lcovPathsByArtifact } = planCoverageGroups(files('coverage-plugins-axios__a-0', { lcovCount: 2 }))
      assert.equal(lcovPathsByArtifact.get('coverage-plugins-axios__a-0').length, 2)
    })

    it('folds cells that share a flag but carry distinct uniqueness suffixes', () => {
      // Cypress varies `spec` outside its flag: eight specs per (version, cypress-version, module)
      // upload distinct artifacts that all belong to the one cypress integration.
      const { groups, cellsByIntegration } = planCoverageGroups([
        ...files('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-0'),
        ...files('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-1'),
      ])
      assert.deepEqual([...groups], [['test-optimization-cypress', ['test-optimization-cypress']]])
      assert.equal(cellsByIntegration.get('test-optimization-cypress').length, 2)
    })

    it('folds distinct version cells into one integration', () => {
      const { groups } = planCoverageGroups([
        ...files('coverage-apm-integrations-next-11.1.4__integration-next-0'),
        ...files('coverage-apm-integrations-next-15.0.0__integration-next-1'),
      ])
      assert.deepEqual([...groups], [['apm-integrations-next', ['apm-integrations-next']]])
    })
  })
})
