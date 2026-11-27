'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { globSync } = require('glob')
const { Minimatch } = require('minimatch')

const { fixtures } = require('../packages/dd-trace/test/plugins/externals')
const { getPluginTestRun, pluginTestPatterns } = require('./helpers/plugin-test-suites')

const repoRoot = path.resolve(__dirname, '..')
const [suiteName, mode, ...extraArgs] = process.argv.slice(2)
const suite = getPluginTestRun(suiteName, mode)
if (!suite) {
  throw new Error(`Unknown plugin test suite or mode: "${suiteName} ${mode}"`)
}

const { PLUGINS, SPEC } = process.env
const { include, exclude } = pluginTestPatterns(suite, PLUGINS ?? (suite.prepareOnly ? '*' : ''), SPEC || '*')
const files = include.flatMap(pattern => globSync(pattern, {
  cwd: repoRoot,
  ignore: exclude,
  nodir: true,
  posix: true,
  windowsPathsNoEscape: true,
}).sort((left, right) => left.localeCompare(right, 'en')))

if (suite.prepare) {
  const selectedFixtures = []
  for (const [name, { specs }] of Object.entries(fixtures)) {
    const match = new Minimatch(specs)
    if (files.some(file => match.match(file))) {
      selectedFixtures.push(name)
    }
  }
  runNode(['scripts/install_plugin_modules.js', ...selectedFixtures])
  runNode(['packages/dd-trace/test/setup/services.js'])
}

if (!suite.prepareOnly) {
  const excludes = exclude.flatMap(pattern => ['--exclude', pattern])
  const mochaArgs = [...(suite.mochaArgs ?? []), ...excludes, ...(files.length ? files : include), ...extraArgs]
  const mochaNodeArgs = [...(suite.nodeArgs ?? []), 'node_modules/mocha/bin/mocha.js', ...mochaArgs]
  switch (suite.coverage) {
    case 'v8':
      runNode(['scripts/c8-ci.js', '--node', suite.npmScript, ...mochaNodeArgs])
      break
    case 'sandbox':
      runNode(['integration-tests/coverage/run-suite.js', ...mochaArgs])
      break
    default:
      runNode(mochaNodeArgs)
  }
}

/** @param {string[]} args */
function runNode (args) {
  const { error, status } = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' })
  if (error) {
    throw error
  }
  if (status !== 0) {
    process.exit(status ?? 1)
  }
}
