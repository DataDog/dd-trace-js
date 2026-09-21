'use strict'

const path = require('node:path')

const tracer = require('dd-trace/ci/init')

const playwrightDirectory = path.dirname(require.resolve('playwright/package.json'))
const { configLoader } = require(path.join(playwrightDirectory, 'lib/common/index'))
const { testRunner } = require(path.join(playwrightDirectory, 'lib/runner/index'))

async function main () {
  // eslint-disable-next-line no-console
  const originalConsoleError = console.error
  const config = await configLoader.loadConfig({
    configDir: process.cwd(),
    resolvedConfigFile: path.join(process.cwd(), 'playwright.config.js'),
  })
  const options = { passWithNoTests: true }

  await testRunner.runAllTestsWithConfig(config, options)
  // eslint-disable-next-line no-console
  if (console.error !== originalConsoleError) throw new Error('console.error was not restored after the first run')

  if (process.env.PLAYWRIGHT_DISABLE_PLUGIN_BETWEEN_RUNS === '1') {
    tracer.use('playwright', false)
    process.stdout.write('PLAYWRIGHT_PLUGIN_DISABLED\n')
  }

  await testRunner.runAllTestsWithConfig(config, options)
  // eslint-disable-next-line no-console
  if (console.error !== originalConsoleError) throw new Error('console.error was not restored after the second run')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
