'use strict'

// Publishes dd-trace-electron by temporarily using package.electron.json as
// package.json so that npm publish picks up the correct name and dependencies.
// Restores the original package.json on success or failure.

const { execSync } = require('node:child_process')
const { copyFileSync, existsSync, readFileSync, renameSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const ELECTRON_JSON = path.join(ROOT, 'package.electron.json')
const README = path.join(ROOT, 'README.md')
const ELECTRON_README = path.join(ROOT, 'README.electron.md')
// Store backups outside the package root so they are never picked up by npm publish.
const BACKUP = path.join(os.tmpdir(), 'dd-trace-package.json.bak')
const README_BACKUP = path.join(os.tmpdir(), 'dd-trace-readme.md.bak')

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
  copyFileSync(README, README_BACKUP)
  backupCreated = true
  copyFileSync(ELECTRON_JSON, PACKAGE_JSON)
  copyFileSync(ELECTRON_README, README)

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
  if (backupCreated) {
    renameSync(BACKUP, PACKAGE_JSON)
    renameSync(README_BACKUP, README)
  }
}
