'use strict'

// Prints a human-readable crash summary from Node.js diagnostic reports to
// stdout so it appears directly in CI logs. Full reports contain sensitive
// data (env vars, heap snapshots) so only the relevant fields are printed:
// header metadata, JS/native stacks, loaded shared objects, and libuv handles.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const inputDir = path.join(os.tmpdir(), 'node-reports')

// Exit silently when there is nothing to print. The action runs on every
// failure (`if: failure()`) but most failures are unrelated to a Node.js
// crash, so logging here would add noise that obscures the real upstream
// error in CI log-surfacing tools.
if (!fs.existsSync(inputDir)) {
  process.exit(0)
}

// If the directory exists but holds no usable reports, the loop simply
// emits nothing (same rationale as the early-return above).
for (const file of fs.readdirSync(inputDir)) {
  if (!file.endsWith('.json')) {
    process.stderr.write(`Skipping non-JSON file: ${file}\n`)
    continue
  }

  let report
  try {
    report = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8'))
  } catch (err) {
    process.stderr.write(`Skipping malformed report ${file}: ${err.message}\n`)
    continue
  }

  const { header = {}, javascriptStack = {}, nativeStack = [], sharedObjects = [], libuv = [] } = report
  const sep = '='.repeat(72)
  const lines = [
    sep,
    `Node.js crash report: ${file}`,
    sep,
    '',
    '== Header ==',
    `  Node.js:   ${header.nodejsVersion ?? '?'}`,
    `  Arch:      ${header.arch ?? '?'}`,
    `  Platform:  ${header.osName ?? header.platform ?? '?'} ${header.osRelease ?? ''}`.trimEnd(),
    `  Signal:    ${header.signal ?? '?'}`,
    `  Reason:    ${header.reason ?? '?'}`,
    `  Time:      ${header.dumpEventTime ?? '?'}`,
    '',
    '== JavaScript stack ==',
    javascriptStack.message ?? '(no message)',
    ...(Array.isArray(javascriptStack.stack) ? javascriptStack.stack : ['(none)']),
    '',
    '== Native stack ==',
    ...(nativeStack.length
      ? nativeStack.map((frame, i) => `  [${i}] ${frame.symbol ?? frame.pc ?? '?'}`)
      : ['(none)']),
    '',
    '== Shared objects ==',
    ...(sharedObjects.length ? sharedObjects.map(obj => `  ${obj.path ?? '?'}`) : ['(none)']),
    '',
    '== libuv handles ==',
    ...(libuv.length ? libuv.map(handle => `  ${JSON.stringify(handle)}`) : ['(none)']),
    '',
  ]

  process.stdout.write(lines.join('\n') + '\n')
}
