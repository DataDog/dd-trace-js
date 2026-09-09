'use strict'

// Publishes dd-trace-electron by temporarily using package.electron.json as
// package.json so that npm publish picks up the correct name and dependencies.
// Restores the original package.json on success or failure.

const { execSync } = require('node:child_process')
const { copyFileSync, existsSync, readFileSync, renameSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { withElectronPackageJson, ROOT, ELECTRON_JSON } = require('./helpers/electron-package-json')

const README = path.join(ROOT, 'README.md')
const ELECTRON_README = path.join(ROOT, 'README.electron.md')
// Store the backup outside the package root so it is never picked up by npm publish.
const README_BACKUP = path.join(os.tmpdir(), 'dd-trace-readme.md.bak')

function run (cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}

async function main () {
  run('node scripts/generate-electron-package.js')

  if (!existsSync(ELECTRON_JSON)) {
    process.stderr.write(
      `publish-electron: ${ELECTRON_JSON} not found after generation. Refusing to publish.\n`
    )
    process.exit(1)
  }

  const { version } = JSON.parse(readFileSync(ELECTRON_JSON, 'utf8'))

  let readmeBackupCreated = false
  try {
    copyFileSync(README, README_BACKUP)
    readmeBackupCreated = true
    copyFileSync(ELECTRON_README, README)

    await withElectronPackageJson(() => {
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
    })
  } finally {
    if (readmeBackupCreated) {
      renameSync(README_BACKUP, README)
    }
  }
}

main()
