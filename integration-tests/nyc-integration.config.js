'use strict'

const path = require('node:path')

const defaultExclude = require('@istanbuljs/schema/default-exclude')

const coverageRoot = process.env.INTEGRATION_COVERAGE_CWD || path.parse(process.cwd()).root
const outputRoot = process.env.INTEGRATION_COVERAGE_OUTPUT_CWD || process.cwd()

const lifecycleEvent = process.env.npm_lifecycle_event || ''
const suiteMatch = lifecycleEvent.match(/^test:integration:(.+):ci$/)
const suiteName = suiteMatch ? suiteMatch[1] : 'integration'

const reportDir = path.join(outputRoot, 'coverage', `integration-${suiteName}`)
const tempDir = path.join(outputRoot, '.nyc_output', `integration-${suiteName}`)

module.exports = {
  cwd: coverageRoot,
  reporter: ['text', 'lcov'],
  reportDir,
  tempDir,
  include: [
    '**/node_modules/dd-trace/packages/**/src/**/*.js',
    '**/node_modules/dd-trace/packages/**/src/**/*.mjs',
    '**/packages/**/src/**/*.js',
    '**/packages/**/src/**/*.mjs'
  ],
  exclude: defaultExclude.concat(['!**/node_modules/dd-trace/**'])
}
