'use strict'
const { expect } = require('chai')
const { checkIntegrity } = require('../src/integrity')
const validOneFile = require('./samples/validOneFile.json')
const tufTargetsMissingTargetFile = require('./samples/tufTargetsMissingTargetFile.json')
const tufTargetsInvalidSignature = require('./samples/tufTargetsInvalidSignature.json')
const tufTargetsSignedWithInvalidKey = require('./samples/tufTargetsSignedWithInvalidKey.json')
const tufTargetsInvalidTargetFileHash = require('./samples/tufTargetsInvalidTargetFileHash.json')
const tufTargetsInvalidTargetFileLength = require('./samples/tufTargetsInvalidTargetFileLength.json')

const TEST_KEY_ID = 'ed7672c9a24abda78872ee32ee71c7cb1d5235e8db4ecbf1ca28b9c50eb75d9e'
const TEST_PUBLIC_KEY = '7d3102e39abe71044d207550bda239c71380d013ec5a115f79f51622630054e6'

describe('Remote configuration Index', () => {
  it('should accept a valid payload', () => {
    const res = checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, validOneFile)
    expect(res)
  })

  it('should fail on tufTargetsMissingTargetFile', () => {
    try {
      checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, tufTargetsMissingTargetFile)
    } catch (e) {
      expect(e.message).to
        .equal('target datadog/2/ASM_DD/ASM_DD-base/config not found in targets')
    }
  })

  it('should fail on tufTargetsInvalidSignature', () => {
    try {
      checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, tufTargetsInvalidSignature)
    } catch (e) {
      expect(e.message).to
        .equal('invalid signature for key ed7672c9a24abda78872ee32ee71c7cb1d5235e8db4ecbf1ca28b9c50eb75d9e')
    }
  })

  it('should fail on tufTargetsSignedWithInvalidKey', () => {
    try {
      checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, tufTargetsSignedWithInvalidKey)
    } catch (e) {
      expect(e.message).to
        .equal('missing signature for key ed7672c9a24abda78872ee32ee71c7cb1d5235e8db4ecbf1ca28b9c50eb75d9e')
    }
  })

  it('should fail on tufTargetsInvalidTargetFileHash', () => {
    try {
      checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, tufTargetsInvalidTargetFileHash)
    } catch (e) {
      expect(e.message).to
        .equal('target datadog/2/ASM_DD/ASM_DD-base/config expected sha256 was 66616b6568617368, ' +
          '4608754de40c82df65d6b8d5d16b2d722721c87bc6fb37fb24cec58ae2d300b7 found')
    }
  })

  it('should fail on tufTargetsInvalidTargetFileLength', () => {
    try {
      checkIntegrity(TEST_PUBLIC_KEY, TEST_KEY_ID, tufTargetsInvalidTargetFileLength)
    } catch (e) {
      expect(e.message).to
        .equal('target datadog/2/ASM_DD/ASM_DD-base/config expected sha256 was 66616b6568617368, ' +
          '4608754de40c82df65d6b8d5d16b2d722721c87bc6fb37fb24cec58ae2d300b7 found')
    }
  })
})
