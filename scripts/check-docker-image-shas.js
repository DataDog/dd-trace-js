#!/usr/bin/env node

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CHECKED_EXTENSIONS = new Set(['.yml', '.yaml'])

// Matches `image: <value>` where the value is on the same line (not a bare `image:` key)
const IMAGE_LINE_RE = /^\s*image:\s+(\S+)\s*(?:#.*)?$/

// Images that genuinely cannot be SHA-pinned at this time.
// Keep this list as short as possible; every entry needs a justification comment.
const ALLOWED_UNPINNED = new Set([
  // No longer published to Docker Hub; needs migration to the new registry first.
  'bitnami/openldap:latest',
])

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
  if (!CHECKED_EXTENSIONS.has(path.extname(file))) continue

  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = IMAGE_LINE_RE.exec(lines[i])
    if (!m) continue

    const ref = m[1]

    // Skip environment variables ($VAR) and GitHub Actions expressions (${{ ... }})
    if (ref.startsWith('$')) continue

    // Skip already-pinned references
    if (ref.includes('@sha256:')) continue

    // Skip known exceptions that cannot currently be pinned
    if (ALLOWED_UNPINNED.has(ref)) continue

    violations.push({ file: file.replaceAll('\\', '/'), line: i + 1, text: lines[i].trim() })
  }
}

if (violations.length) {
  // eslint-disable-next-line no-console
  console.error('Docker images must be pinned to a SHA digest with an inline tag comment:\n')
  for (const { file, line, text } of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${file}:${line}  ${text}`)
  }
  // eslint-disable-next-line no-console
  console.error('\nExample: image: redis@sha256:c9d92d...b2 # 7.0-alpine')
  // eslint-disable-next-line no-console
  console.error('\nRun scripts/pin-docker-images.sh to fetch and apply SHA digests automatically.')

  throw new Error(`Found ${violations.length} unpinned Docker image reference(s).`)
}
