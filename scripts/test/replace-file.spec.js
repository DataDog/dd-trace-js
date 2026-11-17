'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { replaceFile } = require('../replace-file')

describe('scripts/replace-file.js', () => {
  let fixtureDirectory

  beforeEach(() => {
    fixtureDirectory = fs.mkdtempSync(path.join(tmpdir(), 'dd-trace-replace-file-'))
  })

  afterEach(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('replaces a hardlink without mutating its cache entry', () => {
    const cachedFile = path.join(fixtureDirectory, 'cached.js')
    const installedFile = path.join(fixtureDirectory, 'installed.js')
    fs.writeFileSync(cachedFile, 'original', { mode: 0o744 })
    fs.linkSync(cachedFile, installedFile)

    replaceFile(installedFile, 'patched')

    assert.strictEqual(fs.readFileSync(cachedFile, 'utf8'), 'original')
    assert.strictEqual(fs.readFileSync(installedFile, 'utf8'), 'patched')
    assert.strictEqual(fs.statSync(installedFile).mode, fs.statSync(cachedFile).mode)
  })
})
