'use strict'

const assert = require('node:assert/strict')

const semver = require('semver')

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
      '@jest/core': ['24.8.0', '25.5.1', '28.0.0', '29.7.0'],
      mocha: ['5.2.0', '8.0.0', '10.8.2', '11.7.5'],
      playwright: ['1.18.0', '1.38.0', '1.61.0'],
      '@cucumber/cucumber': ['7.0.0', '8.0.0'],
      cypress: ['6.7.0', '12.0.0', '14.5.4'],
      'selenium-webdriver': ['4.11.0'],
      vitest: ['1.6.0', '3.2.6'],
    }
    for (const [dependency, versions] of Object.entries(packageVersions)) {
      versions.push(latestVersions[dependency], semver.inc(latestVersions[dependency], 'patch'))
    }
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['18.20.8', '22.22.3', '26.2.0'],
      plugins: new Map([
        ['@jest/core', 'jest'], ['mocha', 'mocha'],
        ['playwright', 'playwright'], ['@cucumber/cucumber', 'cucumber'],
        ['cypress', 'cypress'], ['selenium-webdriver', 'selenium'], ['vitest', 'vitest'],
      ]),
      getPackageVersions: async dependency => packageVersions[dependency],
    })

    assert.deepStrictEqual(rows.map(row => [row.libraryName, row.versions.map(version => ({
      node: version.testedRuntimes.node, tested: version.tested,
    }))]), [
      ['@cucumber/cucumber', [
        { node: ['26.2.0'], tested: ['7.0.0', latestVersions['@cucumber/cucumber']] },
        { node: ['18.20.8'], tested: ['7.0.0'] },
      ]],
      ['cypress', [
        { node: ['26.2.0'], tested: ['12.0.0', '14.5.4', latestVersions.cypress] },
        { node: ['18.20.8'], tested: ['12.0.0', '14.5.4'] },
      ]],
      ['@jest/core', DD_MAJOR >= 6
        ? [{ node: ['26.2.0', '18.20.8'], tested: ['28.0.0', latestVersions['@jest/core']] }]
        : [
            { node: ['26.2.0'], tested: ['24.8.0', latestVersions['@jest/core']] },
            { node: ['18.20.8'], tested: ['24.8.0', '25.5.1', latestVersions['@jest/core']] },
          ]],
      ['mocha', [
        { node: ['26.2.0'], tested: [DD_MAJOR >= 6 ? '8.0.0' : '5.2.0', latestVersions.mocha] },
        { node: ['18.20.8'], tested: [DD_MAJOR >= 6 ? '8.0.0' : '5.2.0', '11.7.5'] },
      ]],
      ['playwright', [
        { node: ['26.2.0'], tested: [DD_MAJOR >= 6 ? '1.38.0' : '1.18.0', latestVersions.playwright] },
        { node: ['18.20.8'], tested: [DD_MAJOR >= 6 ? '1.38.0' : '1.18.0', '1.61.0'] },
      ]],
      ['selenium-webdriver', [{
        node: ['26.2.0', '18.20.8'], tested: ['4.11.0', latestVersions['selenium-webdriver']],
      }]],
      ['vitest', [
        { node: ['26.2.0'], tested: ['1.6.0', latestVersions.vitest] },
        { node: ['18.20.8'], tested: ['1.6.0', '3.2.6'] },
      ]],
    ])
  })

  it('reports native Pino Pretty boundaries when its external only injects dependencies', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeVersions: ['26.2.0'],
      plugins: new Map([['pino-pretty', 'pino']]),
      getPackageVersions: async () => [
        ...Array.from({ length: 13 }, (_, index) => `${index + 1}.0.0`), latestVersions['pino-pretty'],
      ],
    })

    assert.deepStrictEqual(rows, [supportedIntegration('pino-pretty', 'pino', '>=3 || 1 - 2', [
      ...Array.from({ length: 12 }, (_, index) => `${index + 1}.0.0`), latestVersions['pino-pretty'],
    ])])
  })

  for (const nodeRange of ['>=18', '>=22']) {
    it(`reports WebdriverIO with the default Node catalog and engines ${nodeRange}`, async () => {
      const { rows } = await generateSupportedIntegrations({
        packageInfo: { ...require('../../../package.json'), engines: { node: nodeRange } },
        plugins: new Map([['@wdio/local-runner', 'mocha']]),
        getPackageVersions: async () => ['9.0.0', '9.33.1', latestVersions['@wdio/local-runner']],
      })

      const versions = [{
        supportedRange: '>=9.0.0',
        tested: [latestVersions['@wdio/local-runner']],
        testedRuntimes: { node: ['22.23.4'] },
      }]
      if (nodeRange === '>=18') {
        versions.push({
          supportedRange: '>=9.0.0',
          tested: ['9.0.0'],
          testedRuntimes: { node: ['18.20.8'] },
        })
      }

      assert.deepStrictEqual(rows, [{
        libraryName: '@wdio/local-runner',
        integrationName: 'mocha',
        autoInstrumented: true,
        versions,
      }])
    })
  }

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
 * @returns {{ libraryName: string, integrationName: string, autoInstrumented: boolean,
 *   versions: Array<{ testedRuntimes: { node: string[] }, supportedRange: string, tested: string[] }> }}
 */
function supportedIntegration (dependency, integration, supportedRange, testedVersions, nodeVersion = '26.2.0') {
  return {
    libraryName: dependency,
    integrationName: integration,
    autoInstrumented: true,
    versions: [{
      testedRuntimes: { node: [nodeVersion] },
      supportedRange,
      tested: testedVersions,
    }],
  }
}
