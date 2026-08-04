#!/usr/bin/env node

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CHECKED_EXTENSIONS = new Set(['.yml', '.yaml'])
const CHECKED_BASENAMES = new Set(['Dockerfile'])
const MCR_IMAGE_RE = /^\s*(image:\s+mcr\.microsoft\.com|FROM\s+mcr\.microsoft\.com)/i
const MCR_HOST = 'mcr.microsoft.com'

/**
 * @returns {string[]}
 */
function listFilesFromGit () {
  const stdout = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1024 * 1024 * 128, encoding: 'utf8' })
  return stdout.split('\0').filter(Boolean)
}

/** @type {Array<{file: string, line: number, text: string}>} */
const violations = []

for (const file of listFilesFromGit()) {
  const ext = path.extname(file)
  const base = path.basename(file)
  if (!CHECKED_EXTENSIONS.has(ext) && !CHECKED_BASENAMES.has(base)) continue

  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (MCR_IMAGE_RE.test(line)) {
      violations.push({ file: file.replaceAll('\\', '/'), line: i + 1, text: line.trim() })
    }
  }
}

if (violations.length) {
  // eslint-disable-next-line no-console
  console.error(`Direct use of ${MCR_HOST} is not allowed. Use the GHCR mirror instead:\n`)
  for (const { file, line, text } of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${file}:${line}  ${text}`)
  }
  // eslint-disable-next-line no-console
  console.error(
    '\nReplace mcr.microsoft.com/<image>:<tag>' +
    ' with ghcr.io/datadog/dd-trace-js/mcr.microsoft.com/<image>:<tag>\n' +
    '\nIf the image has not been mirrored yet, use the "Mirror image to GHCR" workflow on GitHub:\n' +
    'https://github.com/DataDog/dd-trace-js/actions/workflows/mirror-image.yml'
  )

  throw new Error(`Found ${violations.length} direct ${MCR_HOST} image reference(s).`)
}
