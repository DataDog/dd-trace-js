'use strict'

// Prints a human-readable crash summary from Node.js diagnostic reports to
// stdout so it appears directly in CI logs. Full reports contain sensitive
// data (env vars, heap snapshots) so only the relevant fields are printed:
// header metadata, JS/native stacks, loaded shared objects, and libuv handles.

const fs = require('node:fs')
const path = require('node:path')

const [inputDir] = process.argv.slice(2)
if (!inputDir) {
  process.stderr.write('Usage: node scrub-node-reports.js <input-dir>\n')
  process.exit(1)
}

if (!fs.existsSync(inputDir)) {
  process.stdout.write(`No report directory at ${inputDir}, nothing to print.\n`)
  process.exit(0)
}

let printed = 0
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
  printed++
}

if (printed === 0) {
  process.stdout.write('No crash reports found.\n')
}
