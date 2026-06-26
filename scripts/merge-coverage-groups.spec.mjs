import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import {
  flagOf, integrationOf, mergeLcovText, planCoverageGroups, planGroups, serializeLcov,
} from './merge-coverage-groups.mjs'

/**
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {number} [options.lcovCount]  Number of per-Node-version lcov files the artifact carries.
 * @returns {{ runId: string, name: string, lcovPaths: string[] }}
 */
function instance (name, { runId = '1', lcovCount = 1 } = {}) {
  const lcovPaths = Array.from({ length: lcovCount },
    (_, index) => `coverage-results/${runId}/${name}/node-2${index}-x/lcov.info`)
  return { runId, name, lcovPaths }
}

describe('merge-coverage-groups', () => {
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
      const flags = [...groups.keys()].sort()
      assert.deepEqual(flags, ['plugins-axios+fs+net', 'plugins-pino+redis'])
      assert.deepEqual(groups.get('plugins-axios+fs+net'), ['plugins-axios', 'plugins-fs', 'plugins-net'])
      for (const integrations of groups.values()) {
        assert.ok(integrations.length <= 3, 'no bucket exceeds three integrations')
      }
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
      const { lcovPathsByArtifact } = planCoverageGroups([
        instance('coverage-plugins-axios__a-0', { runId: '100' }),
        instance('coverage-plugins-axios__a-0', { runId: '205' }),
      ])
      assert.deepEqual(lcovPathsByArtifact.get('coverage-plugins-axios__a-0'),
        ['coverage-results/205/coverage-plugins-axios__a-0/node-20-x/lcov.info'])
    })

    it('merges every per-Node-version lcov a single artifact carries', () => {
      const { lcovPathsByArtifact } = planCoverageGroups([
        instance('coverage-plugins-axios__a-0', { lcovCount: 2 }),
      ])
      assert.equal(lcovPathsByArtifact.get('coverage-plugins-axios__a-0').length, 2)
    })

    it('folds cells that share a flag but carry distinct uniqueness suffixes', () => {
      // Cypress varies `spec` outside its flag: eight specs per (version, cypress-version, module)
      // upload distinct artifacts that all belong to the one cypress integration.
      const { groups, cellsByIntegration } = planCoverageGroups([
        instance('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-0'),
        instance('coverage-test-optimization-cypress-latest-latest-esm__integration-cypress-1'),
      ])
      assert.deepEqual([...groups], [['test-optimization-cypress', ['test-optimization-cypress']]])
      assert.equal(cellsByIntegration.get('test-optimization-cypress').length, 2)
    })

    it('folds distinct version cells into one integration', () => {
      const { groups } = planCoverageGroups([
        instance('coverage-apm-integrations-next-11.1.4__integration-next-0'),
        instance('coverage-apm-integrations-next-15.0.0__integration-next-1'),
      ])
      assert.deepEqual([...groups], [['apm-integrations-next', ['apm-integrations-next']]])
    })
  })

  describe('mergeLcovText + serializeLcov', () => {
    it('sums line, function, and branch hits for a file two cells both covered', () => {
      const cellA = [
        'TN:', 'SF:packages/x.js',
        'FN:1,foo', 'FNF:1', 'FNH:1', 'FNDA:2,foo',
        'DA:1,2', 'DA:2,0', 'DA:3,1', 'LF:3', 'LH:2',
        'BRDA:2,0,0,1', 'BRDA:2,0,1,-', 'BRF:2', 'BRH:1',
        'end_of_record', '',
      ].join('\n')
      const cellB = [
        'TN:', 'SF:packages/x.js',
        'FN:1,foo', 'FNF:1', 'FNH:0', 'FNDA:0,foo',
        'DA:1,0', 'DA:2,5', 'DA:3,0', 'LF:3', 'LH:1',
        'BRDA:2,0,0,-', 'BRDA:2,0,1,3', 'BRF:2', 'BRH:1',
        'end_of_record', '',
      ].join('\n')

      const merged = serializeLcov(mergeLcovText(cellB, mergeLcovText(cellA, new Map())))

      assert.match(merged, /^DA:1,2$/m)
      assert.match(merged, /^DA:2,5$/m)
      assert.match(merged, /^DA:3,1$/m)
      assert.match(merged, /^LH:3$/m) // all three lines hit once the cells combine
      assert.match(merged, /^FNDA:2,foo$/m)
      assert.match(merged, /^BRDA:2,0,0,1$/m)
      assert.match(merged, /^BRDA:2,0,1,3$/m)
      assert.match(merged, /^BRH:2$/m)
    })

    it('keeps records for two different files side by side', () => {
      const text = [
        'TN:', 'SF:packages/a.js', 'DA:1,1', 'LF:1', 'LH:1', 'end_of_record',
        'TN:', 'SF:packages/b.js', 'DA:1,0', 'LF:1', 'LH:0', 'end_of_record', '',
      ].join('\n')

      const merged = serializeLcov(mergeLcovText(text, new Map()))

      assert.match(merged, /^SF:packages\/a\.js$/m)
      assert.match(merged, /^SF:packages\/b\.js$/m)
    })
  })
})
