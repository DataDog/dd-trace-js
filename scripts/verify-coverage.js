'use strict'

const fs = require('node:fs')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs } = require('node:util')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    expected: { type: 'boolean', default: false },
    'report-dir': { type: 'string', default: 'coverage' },
    flags: { type: 'string', default: '' }
  },
  allowPositionals: true
})

const reportDirAbs = path.resolve(process.cwd(), values['report-dir'])

const lcovPath = path.join(reportDirAbs, 'lcov.info')
let lcovContent
try {
  lcovContent = fs.readFileSync(lcovPath, 'utf8')
} catch {
  // ignore
}

// Consider it empty unless we see at least one `SF:` record.
const isMissingOrEmpty = lcovContent === undefined || !/(^|\n)SF:/.test(lcovContent)

// If the file exists but is empty, remove it so uploaders don't pick it up.
if (lcovContent !== undefined && isMissingOrEmpty) {
  try {
    fs.unlinkSync(lcovPath)
  } catch {
    // ignore
  }
}

// If we deleted the last artifact, avoid leaving an empty `coverage/` directory behind.
try {
  const entries = fs.readdirSync(reportDirAbs)
  if (entries.length === 0) {
    fs.rmdirSync(reportDirAbs)
  }
} catch {
  // ignore
}

if (values.expected && isMissingOrEmpty) {
  throw new Error(
    [
      'Expected a non-empty coverage report but none was produced.',
      `reportDir=${reportDirAbs}`,
      'missingOrEmpty=lcov.info',
      `flags=${values.flags}`
    ].join(' ')
  )
}
