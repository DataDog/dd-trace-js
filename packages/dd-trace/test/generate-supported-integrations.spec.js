'use strict'

const assert = require('node:assert/strict')

const { generateSupportedIntegrations } = require('../../../scripts/generate-supported-integrations')
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
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
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
      nodeProfiles: [{ key: '24', version: nodeVersion }],
      plugins,
      getPackageVersions: async dependency => ['2.112.2', latestVersions[dependency]],
    })

    assert.deepStrictEqual(rows, dependencies.map(dependency =>
      supportedIntegration(dependency, 'supabase', '>=2.112.2', ['2.112.2', latestVersions[dependency]])
    ))
  })

  it('includes explicitly exercised AI SDK versions and excludes known-broken versions', async () => {
    const { rows } = await generateSupportedIntegrations({
      nodeProfiles: [{ key: '26', version: '26.2.0' }],
      plugins: new Map([['ai', 'ai']]),
      getPackageVersions: async () => ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '4.0.2', '4.3.19',
        '5.0.0', '6.0.0', '7.0.0', latestVersions.ai],
    })

    assert(!rows[0].versions[0].tested.includes('4.3.19'))
    assert(rows[0].versions[0].tested.includes('4.0.2'))
    assert.strictEqual(rows[0].versions[0].supportedRange, '>=4.0.0 <7.0.0 || >=6.0.0')
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
 * @returns {{ dependencyName: string, integrationName: string, autoInstrumented: boolean,
 *   versions: Array<{ testedRuntimes: { node: string[] }, supportedRange: string, tested: string[] }> }}
 */
function supportedIntegration (dependency, integration, supportedRange, testedVersions) {
  return {
    dependencyName: dependency,
    integrationName: integration,
    autoInstrumented: true,
    versions: [{
      testedRuntimes: { node: [dependency.includes('supabase') ? '24.16.0' : '26.2.0'] },
      supportedRange,
      tested: testedVersions,
    }],
  }
}
