import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { hasUploadFailed, runUpload, runUploadWithRetry } from './run-upload.mjs'

describe('run-upload', () => {
  const uploadCommand = process.execPath
  const siblingCommand = 'codecovcli'
  const missingCommand = 'dd-trace-missing-upload-command'

  it('starts false before any upload has run', () => {
    assert.equal(hasUploadFailed(uploadCommand), false)
    assert.equal(hasUploadFailed(siblingCommand), false)
  })

  it('stays false after an upload that exits zero', async () => {
    await runUpload(uploadCommand, ['-e', 'process.exit(0)'])
    assert.equal(hasUploadFailed(uploadCommand), false)
  })

  it('marks only the failed runUpload command', async () => {
    await runUpload(uploadCommand, ['-e', 'process.exit(1)'])
    assert.equal(hasUploadFailed(uploadCommand), true)
    assert.equal(hasUploadFailed(siblingCommand), false)
  })

  it('stays true once set, even if a later upload succeeds', async () => {
    await runUpload(uploadCommand, ['-e', 'process.exit(0)'])
    assert.equal(hasUploadFailed(uploadCommand), true)
  })

  it('marks the command after runUploadWithRetry exhausts its retries', async () => {
    await runUploadWithRetry(missingCommand, [], 0, 0)
    assert.equal(hasUploadFailed(missingCommand), true)
    assert.equal(hasUploadFailed(siblingCommand), false)
  })
})
