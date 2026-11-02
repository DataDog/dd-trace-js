'use strict'

const assert = require('node:assert/strict')

const { generateSupportedIntegrations } = require('../../../scripts/generate-supported-integrations')
const { DD_MAJOR } = require('../../../version')
const latestVersions = require('./plugins/versions/package.json').dependencies

describe('generate supported integrations', () => {
  it('derives hookless integration ranges from rewriter descriptors', async () => {
    const latest = dependency => latestVersions[dependency]
    const packageVersions = {
      '@azure/cosmos': ['4.4.1', latest('@azure/cosmos')],
      '@langchain/core': ['0.1.0', latest('@langchain/core')],
      '@langchain/langgraph': ['1.1.2', latest('@langchain/langgraph')],
      bullmq: ['5.66.0', latest('bullmq')],
      mercurius: ['13.0.0', '14.0.0', '15.0.0', latest('mercurius')],
    }
    const plugins = new Map([
      ['@azure/cosmos', 'azure-cosmos'],
      ['@langchain/core', 'langchain'],
      ['@langchain/langgraph', 'langgraph'],
      ['bullmq', 'bullmq'],
      ['mercurius', 'graphql'],
    ])

    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['26.2.0'],
      plugins,
      getPackageVersions: async dependency => packageVersions[dependency],
    })

    assert.deepStrictEqual(rows, [
      supportedIntegration('@azure/cosmos', 'azure-cosmos', '>=4.4.1', ['4.4.1', latest('@azure/cosmos')]),
      supportedIntegration('bullmq', 'bullmq', '>=5.66.0', ['5.66.0', latest('bullmq')]),
      supportedIntegration('mercurius', 'graphql', '>=13', [
        '13.0.0', '14.0.0', '15.0.0', latest('mercurius'),
      ]),
      supportedIntegration('@langchain/core', 'langchain', '>=0.1', ['0.1.0', latest('@langchain/core')]),
      supportedIntegration('@langchain/langgraph', 'langgraph', '>=1.1.2', [
        '1.1.2', latest('@langchain/langgraph'),
      ]),
    ])
  })

  it('lists hookless umbrella package aliases next to their instrumented subpackages', async () => {
    const nodeVersion = '24.16.0'
    const dependencies = [
      '@supabase/auth-js',
      '@supabase/functions-js',
      '@supabase/postgrest-js',
      '@supabase/realtime-js',
      '@supabase/storage-js',
      '@supabase/supabase-js',
    ]
    const plugins = new Map(dependencies.slice(0, -1).map(dependency => [dependency, 'supabase']))
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: [nodeVersion],
      plugins,
      getPackageVersions: async dependency => ['2.112.2', latestVersions[dependency]],
    })

    assert.deepStrictEqual(rows, dependencies.map(dependency =>
      supportedIntegration(dependency, 'supabase', '>=2.112.2', ['2.112.2', latestVersions[dependency]], nodeVersion)
    ))
  })

  it('includes explicitly exercised AI SDK versions and excludes known-broken versions', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { rows } = await generateSupportedIntegrations({
        nodeVersions: ['24.16.0', '26.2.0'],
        plugins: new Map([['ai', 'ai']]),
        getPackageVersions: async () => ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '4.0.2', '4.3.19',
          '5.0.0', '6.0.0', '7.0.0', latestVersions.ai],
      })

      assert.strictEqual(rows.length, 1)
      assert(!rows[0].versions[0].tested.includes('4.3.19'))
      assert(rows[0].versions[0].tested.includes('4.0.2'))
      assert.strictEqual(rows[0].versions[0].supportedRange, '>=4.0.0 <7.0.0 || >=6.0.0')
    }
  })

  it('excludes runtime-specific broken versions without narrowing declared support', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['26.2.0'],
      plugins: new Map([['avsc', 'avsc'], ['@grpc/grpc-js', 'grpc']]),
      getPackageVersions: async dependency => dependency === 'avsc'
        ? ['5.0.0', '5.7.9']
        : ['1.0.3', '1.1.3', '1.1.4', '1.14.7'],
    })

    assert.deepStrictEqual(rows, [
      supportedIntegration('avsc', 'avsc', '>=5.0.0', ['5.7.9']),
      supportedIntegration('@grpc/grpc-js', 'grpc', '>=1.0.3', ['1.14.7']),
    ])
  })

  it('excludes skipped Hapi majors without narrowing declared support', async () => {
    const packageVersions = {
      hapi: ['16.0.0', '16.8.4', '17.0.0', '18.1.0'],
      '@hapi/hapi': ['17.9.0', '18.4.1', '19.2.0', '20.3.0', latestVersions['@hapi/hapi']],
    }
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['26.2.0'],
      plugins: new Map([['hapi', 'hapi'], ['@hapi/hapi', 'hapi']]),
      getPackageVersions: async dependency => packageVersions[dependency],
    })

    assert.deepStrictEqual(rows, [
      supportedIntegration('@hapi/hapi', 'hapi', '>=17.9', [latestVersions['@hapi/hapi']]),
      supportedIntegration('hapi', 'hapi', '>=16', ['16.0.0', '16.8.4']),
    ])
  })

  it('includes framework integration jobs without inventing untested intermediate versions', async () => {
    const packageVersions = {
      '@jest/core': ['25.5.1', '28.0.0', '29.7.0', '30.2.0'],
      mocha: ['8.0.0', '10.8.2', '11.7.5', '12.0.0'],
      playwright: ['1.38.0', '1.61.0', '1.62.0'],
      '@cucumber/cucumber': ['7.0.0', '8.0.0', '13.2.0'],
    }
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['18.20.8', '26.2.0'],
      plugins: new Map([
        ['@jest/core', 'jest'], ['mocha', 'mocha'],
        ['playwright', 'playwright'], ['@cucumber/cucumber', 'cucumber'],
      ]),
      getPackageVersions: async dependency => packageVersions[dependency],
    })

    assert.deepStrictEqual(rows.map(row => [row.dependencyName, row.versions.map(version => ({
      node: version.testedRuntimes.node, tested: version.tested,
    }))]), [
      ['@cucumber/cucumber', [{ node: ['26.2.0', '18.20.8'], tested: ['7.0.0'] }]],
      ['@jest/core', DD_MAJOR >= 6
        ? [{ node: ['26.2.0', '18.20.8'], tested: ['30.2.0'] }]
        : [
            { node: ['26.2.0'], tested: ['30.2.0'] },
            { node: ['18.20.8'], tested: ['25.5.1', '30.2.0'] },
          ]],
      ['mocha', [
        { node: ['26.2.0'], tested: ['12.0.0'] },
        { node: ['18.20.8'], tested: ['11.7.5'] },
      ]],
      ['playwright', [
        { node: ['26.2.0'], tested: ['1.62.0'] },
        { node: ['18.20.8'], tested: ['1.61.0'] },
      ]],
    ])
  })

  it('keeps umbrella package aliases out of the runtime hooks and plugin registry', () => {
    const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
    const plugins = require('../src/plugins')

    assert.equal(Object.hasOwn(hooks, '@supabase/supabase-js'), false)
    assert.equal(Object.hasOwn(plugins, '@supabase/supabase-js'), false)
    assert.equal(Object.hasOwn(plugins, '@supabase/auth-js'), true)
  })
})

/**
 * @param {string} dependency
 * @param {string} integration
 * @param {string} supportedRange
 * @param {string[]} testedVersions
 * @param {string} [nodeVersion]
 * @returns {{ dependencyName: string, integrationName: string, autoInstrumented: boolean,
 *   versions: Array<{ testedRuntimes: { node: string[] }, supportedRange: string, tested: string[] }> }}
 */
function supportedIntegration (dependency, integration, supportedRange, testedVersions, nodeVersion = '26.2.0') {
  return {
    dependencyName: dependency,
    integrationName: integration,
    autoInstrumented: true,
    versions: [{
      testedRuntimes: { node: [nodeVersion] },
      supportedRange,
      tested: testedVersions,
    }],
  }
}
