'use strict'

require('dd-trace/ci/init')

const path = require('node:path')

const playwrightDirectory = path.dirname(require.resolve('playwright/package.json'))
const { loadConfigFromFile } = require(path.join(playwrightDirectory, 'lib/common/configLoader.js'))
const { runAllTestsWithConfig } = require(path.join(playwrightDirectory, 'lib/runner/testRunner.js'))

async function main () {
  const config = await loadConfigFromFile('playwright.config.js', {})
  const status = await runAllTestsWithConfig(config)

  if (status !== 'passed') throw new Error(`Unexpected Playwright status: ${status}`)
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
