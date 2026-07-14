'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const CHECK_FLAG = '--check'

const ROOT = path.join(__dirname, '..')
const SOURCE_PACKAGE = path.join(ROOT, 'package.json')
const EXCLUDES_FILE = path.join(__dirname, 'electron-package-excludes.json')
const OUTPUT_FILE = path.join(ROOT, 'package.electron.json')

function generate () {
  const source = JSON.parse(readFileSync(SOURCE_PACKAGE, 'utf8'))
  const excludes = JSON.parse(readFileSync(EXCLUDES_FILE, 'utf8'))

  const output = { ...source, name: 'dd-trace-electron', main: 'index.electron.js' }

  for (const [section, names] of Object.entries(excludes)) {
    if (!output[section]) continue
    for (const name of names) {
      delete output[section][name]
    }
  }

  return JSON.stringify(output, null, 2) + '\n'
}

const generated = generate()
const isCheck = process.argv.includes(CHECK_FLAG)

if (isCheck) {
  let current
  try {
    current = readFileSync(OUTPUT_FILE, 'utf8')
  } catch {
    process.stderr.write(`${OUTPUT_FILE} does not exist. Run: npm run generate:electron-package\n`)
    process.exit(1)
  }
  if (current !== generated) {
    process.stderr.write(
      `${OUTPUT_FILE} is out of date.\nRun: npm run generate:electron-package\n`
    )
    process.exit(1)
  }
  process.stdout.write(`${OUTPUT_FILE} is up to date.\n`)
} else {
  writeFileSync(OUTPUT_FILE, generated)
  process.stdout.write(`Written: ${OUTPUT_FILE}\n`)
}
