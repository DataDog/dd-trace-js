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

// Two layouts to support:
//   - Unit/CI tests under c8 emit the lcov directly at `coverage/lcov.info`.
//   - `integration-tests/coverage/runtime.js` (`getMergedReportDir()`) still
//     emits per-Node-version-and-script subdirectories at
//     `coverage/node-${version}${label}/lcov.info`.
/** @type {{ lcov: string, dir: string }[]} */
const lcovEntries = []
let skippedCount = 0

const flatLcov = path.join(coverageDir, 'lcov.info')
if (fs.existsSync(flatLcov)) {
  lcovEntries.push({ lcov: flatLcov, dir: coverageDir })
}

try {
  for (const entry of fs.readdirSync(coverageDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-')) continue
    const dirAbs = path.join(coverageDir, entry.name)

    // Runtime matrix filters (e.g. cucumber/cypress version guards) can legitimately skip
    // every test. `merge-lcov.js` drops a `.skipped` sentinel in that case so we stay silent
    // instead of failing on an empty report.
    if (fs.existsSync(path.join(dirAbs, '.skipped'))) {
      try { fs.rmSync(dirAbs, { recursive: true, force: true }) } catch {}
      skippedCount++
      continue
    }

    lcovEntries.push({ lcov: path.join(dirAbs, 'lcov.info'), dir: dirAbs })
  }
} catch {}

if (lcovEntries.length === 0 && skippedCount > 0) {
  process.stdout.write('All coverage reports were skipped (matrix filters dropped every test). Skipping upload.\n')
  process.exit(0)
}

if (lcovEntries.length === 0) {
  throw new Error(
    format(
      'No coverage report found under %s. Expected `lcov.info` either directly or in a ' +
      '`node-<version>-<script>` subdirectory (check that the test step produced coverage ' +
      'and that no later step wiped it). Flags: %s.',
      path.relative(cwd, coverageDir) || '.',
      values.flags
    )
  )
}

const emptyEntries = []

for (const { lcov, dir } of lcovEntries) {
  let lcovContent
  try {
    lcovContent = fs.readFileSync(lcov, 'utf8')
  } catch {}

  // Consider it empty unless we see at least one `SF:` record.
  const isMissingOrEmpty = lcovContent === undefined || !/(^|\n)SF:/.test(lcovContent)
  if (!isMissingOrEmpty) continue

  emptyEntries.push(lcov)

  // If the file exists but is empty, remove it so uploaders don't pick it up.
  if (lcovContent !== undefined) {
    try { fs.unlinkSync(lcov) } catch {}
  }

  // If we deleted the last artifact in a per-version subdirectory, avoid leaving it behind.
  if (dir !== coverageDir) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {}
  }
}

if (emptyEntries.length === lcovEntries.length) {
  throw new Error(
    format(
      'Expected at least one non-empty lcov.info coverage report. Searched in %s with flags %s.',
      lcovEntries.map(({ lcov }) => path.relative(cwd, lcov)).join(','),
      values.flags
    )
  )
}
