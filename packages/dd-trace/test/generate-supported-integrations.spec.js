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
