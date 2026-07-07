'use strict'

const jest = require('jest')

function getJestRunArgs (options) {
  const args = [
    '--no-cache',
    '--runInBand',
  ]

  if (process.env.USE_CONFIG_FILE) {
    args.push('--config', require.resolve('../config-jest.js'))
  } else {
    args.push(
      '--rootDir', process.cwd(),
      '--testPathIgnorePatterns', options.testPathIgnorePatterns.join('|'),
      '--modulePathIgnorePatterns', options.modulePathIgnorePatterns.join('|'),
      '--testRegex', options.testRegex.source,
      '--testRunner', options.testRunner,
      '--testEnvironment', options.testEnvironment
    )
  }

  if (options.coverage) {
    args.push('--coverage')
  }
  if (options.collectCoverageFrom) {
    for (const coveragePattern of options.collectCoverageFrom) {
      args.push(`--collectCoverageFrom=${coveragePattern}`)
    }
  }
  if (options._) {
    args.push(...options._)
  }
  if (options.coverageReporters) {
    for (const coverageReporter of options.coverageReporters) {
      args.push(`--coverageReporters=${coverageReporter}`)
    }
  }

  return args
}

const options = {
  projects: [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.bun/'],
  cache: false,
  testRegex: process.env.TESTS_TO_RUN ? new RegExp(process.env.TESTS_TO_RUN) : /test\/ci-visibility-test/,
  coverage: !!process.env.ENABLE_CODE_COVERAGE,
  runInBand: true,
  shard: process.env.TEST_SHARD || undefined,
  setupFilesAfterEnv: process.env.SETUP_FILES_AFTER_ENV ? process.env.SETUP_FILES_AFTER_ENV.split(',') : [],
  testRunner: 'jest-circus/runner',
  testEnvironment: 'node',
}

if (process.env.RUN_IN_PARALLEL) {
  delete options.runInBand
  options.maxWorkers = Number(process.env.MAX_WORKERS) || 2
}

if (process.env.USE_WORKER_THREADS) {
  delete options.runInBand
  options.maxWorkers = 2
  options.workerThreads = true
}

if (process.env.OLD_RUNNER) {
  options.testRunner = 'jest-jasmine2'
}

if (process.env.ENABLE_JSDOM) {
  options.testEnvironment = 'jsdom'
}

if (process.env.ENABLE_HAPPY_DOM) {
  options.testEnvironment = '@happy-dom/jest-environment'
}

if (process.env.CUSTOM_TEST_ENVIRONMENT) {
  options.testEnvironment = process.env.CUSTOM_TEST_ENVIRONMENT
}

if (process.env.COLLECT_COVERAGE_FROM) {
  options.collectCoverageFrom = process.env.COLLECT_COVERAGE_FROM.split(',')
}

if (process.argv.length > 2) {
  options._ = process.argv.slice(2)
}

if (process.env.COVERAGE_REPORTERS) {
  options.coverageReporters = process.env.COVERAGE_REPORTERS.split(',')
}

if (process.env.DO_NOT_INJECT_GLOBALS) {
  options.injectGlobals = false
}

if (process.env.WAIT_FOR_UNHANDLED_REJECTIONS) {
  options.waitForUnhandledRejections = true
}

if (process.env.WORKER_IDLE_MEMORY_LIMIT) {
  options.workerIdleMemoryLimit = Number(process.env.WORKER_IDLE_MEMORY_LIMIT)
}

if (process.env.JEST_BAIL) {
  options.bail = true
}

if (process.env.USE_JEST_RUN) {
  jest.run(getJestRunArgs(options)).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error)
  })
} else {
  jest.runCLI(
    options,
    options.projects
  ).then((results) => {
    if (process.send) {
      process.send('finished')
    }
    if (process.env.SHOULD_CHECK_RESULTS) {
      const exitCode = results.results.success ? 0 : 1
      process.exit(exitCode)
    }
  })
}
