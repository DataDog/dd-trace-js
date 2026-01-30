#!/usr/bin/env node

'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

/** @type {Set<string>} */
const FORBIDDEN_BASENAMES = new Set([
  'coverage.json', // Common coverage JSON basename (Codecov auto-discovery can treat it as a report)
  'coverage-final.json', // istanbul/nyc: json reporter output
  'coverage-summary.json', // istanbul/nyc: json-summary reporter output
  'lcov.info', // istanbul/nyc: lcov reporter output
  'cobertura-coverage.xml', // istanbul/nyc: cobertura reporter output
  'clover.xml', // istanbul/nyc: clover reporter output
  'coverage.xml', // Generic coverage XML basename used by various ecosystems/tools (avoid committing it)
  'cobertura.xml' // Alternative Cobertura XML basename used by some tools/setups (avoid committing it)
])

/**
 * @returns {string[]}
 */
function listFilesFromGit () {
  const stdout = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1024 * 1024 * 128, encoding: 'utf8' })
  return stdout.split('\0').filter(Boolean)
}

const matches = []
for (const file of listFilesFromGit()) {
  if (FORBIDDEN_BASENAMES.has(path.basename(file))) {
    matches.push(file.replaceAll('\\', '/'))
  }
}

if (matches.length) {
  // eslint-disable-next-line no-console
  console.error('Forbidden coverage artifact file(s) found in the repository:\n')
  for (const m of matches.sort()) {
    // eslint-disable-next-line no-console
    console.error(`- ${m}`)
  }

  throw new Error('Please remove/rename these files (fixtures should not use coverage artifact filenames).')
}
