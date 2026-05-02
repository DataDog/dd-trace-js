'use strict'

// Strips sensitive data from Node.js diagnostic reports before CI artifact
// upload. Drops `environmentVariables` (may contain DD_API_KEY, GITHUB_TOKEN,
// and other secrets injected into CI) and `header.commandLine` (may include
// args with tokens). Everything useful for diagnosing native crashes is kept:
// JS and native stacks, loaded shared objects, heap stats, libuv handles.

const fs = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
if (!dir) {
  process.stderr.write('Usage: node scrub-node-reports.js <dir>\n')
  process.exit(1)
}

if (!fs.existsSync(dir)) {
  process.stdout.write(`No report directory at ${dir}, nothing to scrub.\n`)
  process.exit(0)
}

let scrubbed = 0
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.json')) continue
  const full = path.join(dir, file)

  let report
  try {
    report = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (err) {
    process.stderr.write(`Skipping ${file}: ${err.message}\n`)
    continue
  }

  if (report.environmentVariables) {
    report.environmentVariables = '[redacted]'
  }
  if (report.header?.commandLine) {
    report.header.commandLine = '[redacted]'
  }

  fs.writeFileSync(full, JSON.stringify(report, null, 2))
  scrubbed++
}
process.stdout.write(`Scrubbed ${scrubbed} report(s) in ${dir}\n`)
