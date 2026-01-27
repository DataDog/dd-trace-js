'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

function usage (message) {
  if (message) process.stderr.write(`${message}\n`)
  process.stderr.write('Usage: node scripts/run-integration-coverage.js <suite> <mocha args...>\n')
  process.exit(1)
}

const args = process.argv.slice(2)
const suiteName = args.shift()
if (!suiteName) usage('Missing suite name.')
if (args.length === 0) usage('Missing mocha args.')

const env = {
  ...process.env,
  INTEGRATION_COVERAGE: '1',
  INTEGRATION_COVERAGE_NAME: suiteName
}

const mochaPath = path.resolve(process.cwd(), 'node_modules', 'mocha', 'bin', 'mocha.js')
const mochaCmd = process.execPath
const mochaArgs = [mochaPath, ...args]
const mochaResult = spawnSync(mochaCmd, mochaArgs, { stdio: 'inherit', env })
if (mochaResult.error) {
  process.stderr.write(`${mochaResult.error.message}\n`)
  process.exit(1)
}
if (typeof mochaResult.status === 'number' && mochaResult.status !== 0) {
  process.exit(mochaResult.status)
}

const reportScript = path.join(__dirname, 'integration-coverage-report.js')
const reportResult = spawnSync(process.execPath, [reportScript], { stdio: 'inherit', env })
if (reportResult.error) {
  process.stderr.write(`${reportResult.error.message}\n`)
  process.exit(1)
}
if (typeof reportResult.status === 'number' && reportResult.status !== 0) {
  process.exit(reportResult.status)
}
