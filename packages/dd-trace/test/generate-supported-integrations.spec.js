'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const scriptPath = path.join(__dirname, '../../../scripts/generate-supported-integrations.js')
const versions = require('./plugins/versions/package.json').dependencies

describe('generate supported integrations', () => {
  it('derives hookless integration ranges from rewriter descriptors', () => {
    const stdout = execFileSync(process.execPath, ['--eval', `
      global.fetch = async () => ({ ok: false })
      const { generateSupportedIntegrations } = require(${JSON.stringify(scriptPath)})
      generateSupportedIntegrations().then(({ rows }) => {
        const names = new Set([
          '@azure/cosmos',
          '@langchain/core',
          '@langchain/langgraph',
          'bullmq',
          'mercurius',
        ])
        console.log(JSON.stringify(rows.filter(row => names.has(row.dependency))))
      })
    `], { encoding: 'utf8' })

    assert.deepStrictEqual(JSON.parse(stdout), [
      integration('@azure/cosmos', 'azure-cosmos', '4.4.1'),
      integration('@langchain/core', 'langchain', '0.1.0'),
      integration('@langchain/langgraph', 'langgraph', '1.1.2'),
      integration('bullmq', 'bullmq', '5.66.0'),
      integration('mercurius', 'graphql', '13.0.0'),
    ])
  })

  it('lists hookless umbrella package aliases next to their instrumented subpackages', () => {
    const stdout = execFileSync(process.execPath, ['--eval', `
      global.fetch = async () => ({ ok: false })
      const { generateSupportedIntegrations } = require(${JSON.stringify(scriptPath)})
      generateSupportedIntegrations().then(({ rows }) => {
        console.log(JSON.stringify(rows.filter(row => row.dependency.startsWith('@supabase/'))))
      })
    `], { encoding: 'utf8' })

    assert.deepStrictEqual(JSON.parse(stdout), [
      integration('@supabase/auth-js', 'supabase', '2.112.2'),
      integration('@supabase/functions-js', 'supabase', '2.112.2'),
      integration('@supabase/postgrest-js', 'supabase', '2.112.2'),
      integration('@supabase/realtime-js', 'supabase', '2.112.2'),
      integration('@supabase/storage-js', 'supabase', '2.112.2'),
      integration('@supabase/supabase-js', 'supabase', '2.112.2'),
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

function integration (dependency, name, minimum) {
  return {
    dependency,
    integration: name,
    minimum_tracer_supported: minimum,
    max_tracer_supported: versions[dependency],
    'auto-instrumented': 'True',
  }
}
