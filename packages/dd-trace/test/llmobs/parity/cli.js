'use strict'

const fs = require('node:fs')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs } = require('node:util')

const { capture } = require('./capture')
const { diffAll } = require('./diff')
const { importCassette } = require('./import-vcrpy')
const { writeReport } = require('./report')

const { positionals, values } = parseArgs({
  options: {
    sdk: { type: 'string' },
    integration: { type: 'string' },
    scenario: { type: 'string' },
    cassette: { type: 'string' },
    output: { type: 'string' },
    provider: { type: 'string' },
  },
  allowPositionals: true,
})
const command = positionals[0]
const FIXTURES_DIR = path.join(__dirname, 'fixtures')

function scenarioNames () {
  const integrations = values.integration ? [values.integration] : fs.readdirSync(FIXTURES_DIR)
  return integrations.flatMap(integration => {
    const dir = path.join(FIXTURES_DIR, integration)
    const scenarios = values.scenario
      ? [values.scenario]
      : fs.readdirSync(dir).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5))
    return scenarios.map(scenario => ({ integration, scenario }))
  })
}

async function main () {
  if (command === 'import-vcrpy') {
    if (!values.cassette || !values.output || !values.provider) {
      throw new Error('import-vcrpy requires --cassette, --output, and --provider')
    }
    importCassette(values.cassette, values.output, values.provider)
    return
  }
  if (command === 'capture') {
    await capture({ sdk: values.sdk, integration: values.integration, scenario: values.scenario })
    return
  }
  if (command === 'diff') {
    const results = diffAll(values.integration, values.scenario)
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
    return
  }
  if (command === 'report') {
    writeReport(diffAll(values.integration, values.scenario))
    return
  }
  if (command === 'run') {
    for (const { integration, scenario } of scenarioNames()) {
      await capture({ sdk: 'py', integration, scenario })
      await capture({ sdk: 'js', integration, scenario })
    }
    writeReport(diffAll())
    return
  }
  throw new Error('usage: cli.js import-vcrpy|capture|diff|report|run')
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
