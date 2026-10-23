import assert from 'node:assert/strict'

before(() => {
  assert.fail('This hook must be skipped by Test Impact Analysis')
})

// eslint-disable-next-line mocha/no-top-level-tests
it('root-level ES module test', () => {
  assert.fail('This test must be skipped by Test Impact Analysis')
})
