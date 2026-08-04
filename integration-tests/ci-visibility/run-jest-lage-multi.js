'use strict'

const jest = require('jest')

async function runForPackage (packageName, testRegex) {
  process.env.LAGE_PACKAGE_NAME = packageName

  const options = {
    projects: [__dirname],
    testPathIgnorePatterns: ['/node_modules/'],
    modulePathIgnorePatterns: ['<rootDir>/\\.bun/'],
    cache: false,
    testRegex,
    runInBand: true,
    testRunner: 'jest-circus/runner',
    testEnvironment: 'node',
  }

  return jest.runCLI(options, options.projects)
}

async function main () {
  const firstResults = await runForPackage('my-lage-package-a', /test\/ci-visibility-test\.js$/)
  const secondResults = await runForPackage('my-lage-package-b', /test\/ci-visibility-test-2\.js$/)

  if (process.send) {
    process.send('finished')
  }

  const exitCode = firstResults.results.success && secondResults.results.success ? 0 : 1
  process.exit(exitCode)
}

main()
