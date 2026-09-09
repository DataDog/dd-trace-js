'use strict'

const { copyFileSync, renameSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const ELECTRON_JSON = path.join(ROOT, 'package.electron.json')

/**
 * Temporarily swaps package.json for the generated package.electron.json for the duration of
 * `fn`, so npm-facing tooling (npm publish, bun pm pack) picks up the dd-trace-electron name,
 * main entry, and reduced dependency set. Restores the original package.json afterward, even if
 * `fn` throws or rejects. Run `node scripts/generate-electron-package.js` first so
 * package.electron.json is up to date.
 *
 * @param {() => void | Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withElectronPackageJson (fn) {
  const backupPath = path.join(os.tmpdir(), `dd-trace-package.json.bak-${process.pid}`)
  copyFileSync(PACKAGE_JSON, backupPath)
  try {
    copyFileSync(ELECTRON_JSON, PACKAGE_JSON)
    await fn()
  } finally {
    renameSync(backupPath, PACKAGE_JSON)
  }
}

module.exports = { withElectronPackageJson, ROOT, PACKAGE_JSON, ELECTRON_JSON }
