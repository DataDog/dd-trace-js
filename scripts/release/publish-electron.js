'use strict'

// Publishes dd-trace-electron by temporarily using package.electron.json as
// package.json so that npm publish picks up the correct name and dependencies.
// Restores the original package.json on success or failure.

const { execSync } = require('node:child_process')
const { copyFileSync, existsSync, readFileSync, renameSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const ELECTRON_JSON = path.join(ROOT, 'package.electron.json')
const BACKUP = path.join(ROOT, 'package.json.bak')

function run (cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}

run('node scripts/generate-electron-package.js')

if (!existsSync(ELECTRON_JSON)) {
  process.stderr.write(
    `publish-electron: ${ELECTRON_JSON} not found after generation. Refusing to publish.\n`
  )
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(ELECTRON_JSON, 'utf8'))

let backupCreated = false
try {
  copyFileSync(PACKAGE_JSON, BACKUP)
  backupCreated = true
  copyFileSync(ELECTRON_JSON, PACKAGE_JSON)

  let skip = false
  try {
    const published = execSync(
      `npm view dd-trace-electron@${version} version`,
      { cwd: ROOT, stdio: 'pipe' }
    ).toString().trim()
    if (published === version) {
      process.stdout.write(`Version ${version} already published, skipping.\n`)
      skip = true
    }
  } catch {
    // version not found on registry — proceed with publish
  }

  if (!skip) {
    run(`npm publish ${process.argv.slice(2).join(' ')}`)
  }
} finally {
  if (backupCreated) renameSync(BACKUP, PACKAGE_JSON)
}
