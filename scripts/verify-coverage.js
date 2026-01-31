'use strict'

const fs = require('node:fs')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs, format } = require('node:util')

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    flags: { type: 'string', default: '' }
  },
  allowPositionals: true
})

const cwd = process.cwd()

/** @type {string[]} */
const reportDirsAbs = []

// If the default report dir is being used, prefer checking all top-level `coverage-node-*` directories.
try {
  const entries = fs.readdirSync(cwd, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('coverage-node-')) {
      reportDirsAbs.push(path.join(cwd, entry.name))
    }
  }
} catch {
  // ignore
}

const emptyReportDirs = []

for (const dirAbs of reportDirsAbs) {
  const lcovPath = path.join(dirAbs, 'lcov.info')
  let lcovContent
  try {
    lcovContent = fs.readFileSync(lcovPath, 'utf8')
  } catch {
    // ignore
  }

  // Consider it empty unless we see at least one `SF:` record.
  const isMissingOrEmpty = lcovContent === undefined || !/(^|\n)SF:/.test(lcovContent)

  if (!isMissingOrEmpty) {
    continue
  }

  emptyReportDirs.push(dirAbs)

  // If the file exists but is empty, remove it so uploaders don't pick it up.
  if (lcovContent !== undefined) {
    try {
      fs.unlinkSync(lcovPath)
    } catch {
      // ignore
    }
  }

  // If we deleted the last artifact, avoid leaving an empty coverage directory behind.
  try {
    const entries = fs.readdirSync(dirAbs)
    if (entries.length === 0) {
      fs.rmdirSync(dirAbs)
    }
  } catch {
    // ignore
  }
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
