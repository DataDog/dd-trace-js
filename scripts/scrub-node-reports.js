'use strict'

// Strips sensitive data from Node.js diagnostic reports before CI artifact
// upload. Drops `environmentVariables` (may contain DD_API_KEY, GITHUB_TOKEN,
// and other secrets injected into CI) and `header.commandLine` (may include
// args with tokens). Everything useful for diagnosing native crashes is kept:
// JS and native stacks, loaded shared objects, heap stats, libuv handles.
//
// Writes sanitized reports to <output-dir> so only successfully scrubbed files
// are ever uploaded. Non-JSON files and reports that fail to parse are skipped
// and never written to the output directory (fail-closed).

const fs = require('node:fs')
const path = require('node:path')

const [inputDir, outputDir] = process.argv.slice(2)
if (!inputDir || !outputDir) {
  process.stderr.write('Usage: node scrub-node-reports.js <input-dir> <output-dir>\n')
  process.exit(1)
}

if (!fs.existsSync(inputDir)) {
  process.stdout.write(`No report directory at ${inputDir}, nothing to scrub.\n`)
  process.exit(0)
}

fs.mkdirSync(outputDir, { recursive: true })

let scrubbed = 0
for (const file of fs.readdirSync(inputDir)) {
  if (!file.endsWith('.json')) {
    process.stderr.write(`Skipping non-JSON file: ${file}\n`)
    continue
  }
  const full = path.join(inputDir, file)

  let report
  try {
    report = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (err) {
    process.stderr.write(`Skipping malformed report ${file}: ${err.message}\n`)
    continue
  }

  if (report.environmentVariables) {
    report.environmentVariables = '[redacted]'
  }
  if (report.header?.commandLine) {
    report.header.commandLine = '[redacted]'
  }

  fs.writeFileSync(path.join(outputDir, file), JSON.stringify(report, null, 2))
  scrubbed++
}
process.stdout.write(`Scrubbed ${scrubbed} report(s) from ${inputDir} into ${outputDir}\n`)
