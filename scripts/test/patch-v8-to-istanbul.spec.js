'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { replaceFile } = require('../replace-file')

const repoRoot = path.resolve(__dirname, '..', '..')
const patchScript = path.join(repoRoot, 'scripts', 'patch-v8-to-istanbul.js')
const lineTarget = path.join(repoRoot, 'node_modules', 'v8-to-istanbul', 'lib', 'line.js')
const applyTarget = path.join(repoRoot, 'node_modules', 'v8-to-istanbul', 'lib', 'v8-to-istanbul.js')
const lineOriginal = `    // we start with all lines having been executed, and work
    // backwards zeroing out lines based on V8 output.
    this.count = 1`
const applyOriginal = `          if (startCol <= line.startCol && endCol >= line.endCol && !line.ignore) {
            line.count = range.count
          }`

describe('patch-v8-to-istanbul', () => {
  let originalLineSource
  let originalApplySource

  beforeEach(() => {
    originalLineSource = fs.readFileSync(lineTarget)
    originalApplySource = fs.readFileSync(applyTarget)
  })

  afterEach(() => {
    if (fs.existsSync(lineTarget)) {
      replaceFile(lineTarget, originalLineSource)
    } else {
      fs.writeFileSync(lineTarget, originalLineSource)
    }
    replaceFile(applyTarget, originalApplySource)
    delete require.cache[patchScript]
  })

  it('patches both local coverage files', () => {
    replaceFile(lineTarget, lineOriginal)
    replaceFile(applyTarget, applyOriginal)

    delete require.cache[patchScript]
    require(patchScript)

    assert.match(fs.readFileSync(lineTarget, 'utf8'), /record firstColumn/)
    assert.match(fs.readFileSync(applyTarget, 'utf8'), /zero lines covered from first non-whitespace column/)
  })

  it('skips a missing local coverage file', () => {
    fs.rmSync(lineTarget)
    replaceFile(applyTarget, applyOriginal)

    delete require.cache[patchScript]
    require(patchScript)

    assert.strictEqual(fs.existsSync(lineTarget), false)
    assert.match(fs.readFileSync(applyTarget, 'utf8'), /zero lines covered from first non-whitespace column/)
  })
})
