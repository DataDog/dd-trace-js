'use strict'

const assert = require('node:assert/strict')

const {
  findTestsByIdentity,
} = require('../../../../ci/test-optimization-validation/payload-normalizer')

describe('test optimization validation payload normalizer', () => {
  it('requires provided identity file and suite values to match test events', () => {
    const events = [
      {
        type: 'test',
        testName: 'basic-pass',
        testSuite: 'generated suite',
        testSourceFile: '/repo/generated/basic-pass.test.js',
      },
      {
        type: 'test',
        testName: 'basic-pass',
        testSuite: 'other suite',
        testSourceFile: '/repo/other/basic-pass.test.js',
      },
    ]

    assert.deepStrictEqual(findTestsByIdentity(events, [
      {
        name: 'basic-pass',
        file: '/repo/generated/basic-pass.test.js',
        suite: 'generated suite',
      },
    ]), [events[0]])
    assert.deepStrictEqual(findTestsByIdentity(events, [
      {
        name: 'basic-pass',
        file: '/repo/generated/basic-pass.test.js',
        suite: 'other suite',
      },
    ]), [])
    assert.deepStrictEqual(findTestsByIdentity(events, [
      {
        name: 'basic-pass',
        file: '/repo/generated/basic-pass.test.js',
        suite: 'other suite',
      },
    ], { ignoreSuite: true }), [events[0]])
    assert.deepStrictEqual(findTestsByIdentity(events, [
      {
        name: 'basic-pass',
        file: '/repo/missing/basic-pass.test.js',
      },
    ]), [])
  })
})
