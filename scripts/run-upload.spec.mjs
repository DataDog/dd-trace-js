import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { hasUploadFailed, runUpload, runUploadWithRetry } from './run-upload.mjs'

describe('run-upload', () => {
  // `anyUploadFailed` is process-lifetime state (mirrors real usage: it should never reset mid-run),
  // so this must run before any test below flips it, and every later assertion builds on that order.
  it('starts false before any upload has run', () => {
    assert.equal(hasUploadFailed(), false)
  })

  it('stays false after an upload that exits zero', async () => {
    await runUpload(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(hasUploadFailed(), false)
  })

  it('flips true after runUpload sees a non-zero exit', async () => {
    await runUpload(process.execPath, ['-e', 'process.exit(1)'])
    assert.equal(hasUploadFailed(), true)
  })

  it('stays true once set, even if a later upload succeeds', async () => {
    await runUpload(process.execPath, ['-e', 'process.exit(0)'])
    assert.equal(hasUploadFailed(), true)
  })

  it('flips true after runUploadWithRetry exhausts its retries', async () => {
    await runUploadWithRetry(process.execPath, ['-e', 'process.exit(1)'], 0, 0)
    assert.equal(hasUploadFailed(), true)
  })
})
