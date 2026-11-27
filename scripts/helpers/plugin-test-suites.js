'use strict'

const pluginTests = 'packages/datadog-plugin-@($PLUGINS)/test'
const integrationTests = `${pluginTests}/integration-test`
const instrumentationTests = 'packages/datadog-instrumentations/test/@($PLUGINS).spec.js'

const suites = {
  plugins: {
    include: [`${pluginTests}/**/$SPEC*.spec.js`],
    mochaArgs: ['--fail-zero'],
    nodeArgs: ['--expose-gc'],
    npmScript: 'test:plugins',
  },
  integration: {
    include: [`${integrationTests}/**/$SPEC*.spec.js`],
  },
  unit: {
    include: [instrumentationTests, `${pluginTests}/**/*.spec.js`],
    exclude: [`${integrationTests}/**/*.spec.js`],
  },
  instrumentations: {
    include: [instrumentationTests],
    mochaArgs: ['--fail-zero'],
    npmScript: 'test:instrumentations',
  },
  appsec: {
    include: ['packages/dd-trace/test/appsec/**/*.@($PLUGINS).plugin.spec.js'],
    npmScript: 'test:appsec:plugins',
  },
  llmobs: {
    include: ['packages/dd-trace/test/llmobs/plugins/@($PLUGINS)/*.spec.js'],
    npmScript: 'test:llmobs:plugins',
  },
}

const modes = {
  run: { prepare: false },
  prepare: { prepare: true, prepareOnly: true },
  setup: { prepare: true },
  ci: { prepare: true, coverage: 'v8' },
  coverage: { prepare: true, coverage: 'sandbox' },
}

/**
 * @param {string} name
 * @param {string} mode
 */
function getPluginTestRun (name, mode) {
  if (Object.hasOwn(suites, name) && Object.hasOwn(modes, mode)) {
    return { ...suites[name], ...modes[mode] }
  }
}

/**
 * @param {{ include: string[], exclude?: string[] }} suite
 * @param {string} plugins
 * @param {string} spec
 */
function pluginTestPatterns (suite, plugins, spec) {
  const values = { PLUGINS: plugins, SPEC: spec }

  /** @param {string} pattern */
  const expand = pattern => pattern.replaceAll(/\$(PLUGINS|SPEC)/g, (_, name) => values[name])

  return { include: suite.include.map(expand), exclude: suite.exclude?.map(expand) ?? [] }
}

module.exports = { getPluginTestRun, pluginTestPatterns }
