'use strict'

const fs = require('node:fs')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs, format } = require('node:util')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    flags: { type: 'string', default: '' },
  },
  allowPositionals: true,
})

const cwd = process.cwd()
const coverageDir = path.join(cwd, 'coverage')

/** @type {string[]} */
const reportDirsAbs = []

// Match `scripts/run-c8.js` and `integration-tests/coverage/runtime.js` (`getMergedReportDir()`),
// which both emit `coverage/node-${version}${label}` directories so Codecov can attribute each
// test script/Node.js combination independently.
try {
  for (const entry of fs.readdirSync(coverageDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('node-')) {
      reportDirsAbs.push(path.join(coverageDir, entry.name))
    }
  }
} catch {}

if (reportDirsAbs.length === 0) {
  throw new Error(
    format(
      'No coverage report directories found under %s. ' +
      'Expected at least one `node-<version>-<script>` subdirectory with an `lcov.info` ' +
      '(check that the test step produced coverage and that no later step wiped it). Flags: %s.',
      path.relative(cwd, coverageDir) || '.',
      values.flags
    )
  )
}

const emptyReportDirs = []

for (const dirAbs of reportDirsAbs) {
  // Runtime matrix filters (e.g. cucumber/cypress version guards) can legitimately skip
  // every test. `merge-lcov.js` drops a `.skipped` sentinel in that case so we stay silent
  // instead of failing on an empty report.
  if (fs.existsSync(path.join(dirAbs, '.skipped'))) {
    try {
      fs.rmSync(dirAbs, { recursive: true, force: true })
    } catch {}
    continue
  }

  const lcovPath = path.join(dirAbs, 'lcov.info')
  let lcovContent
  try {
    lcovContent = fs.readFileSync(lcovPath, 'utf8')
  } catch {}

  // Consider it empty unless we see at least one `SF:` record.
  const isMissingOrEmpty = lcovContent === undefined || !/(^|\n)SF:/.test(lcovContent)
  if (!isMissingOrEmpty) continue

  emptyReportDirs.push(dirAbs)

  // If the file exists but is empty, remove it so uploaders don't pick it up.
  if (lcovContent !== undefined) {
    try {
      fs.unlinkSync(lcovPath)
    } catch {}
  }

  // If we deleted the last artifact, avoid leaving an empty coverage directory behind.
  try {
    if (fs.readdirSync(dirAbs).length === 0) fs.rmdirSync(dirAbs)
  } catch {}
}

if (emptyReportDirs.length > 0) {
  throw new Error(
    format(
      'Expected non-empty lcov.info coverage report but none was produced in %s. Searched in %s with flags %s.',
      emptyReportDirs.map(d => path.relative(cwd, d) || '.').join(','),
      reportDirsAbs.map(d => path.relative(cwd, d) || '.').join(','),
      values.flags
    )
  )
}
