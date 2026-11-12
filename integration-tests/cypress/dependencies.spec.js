'use strict'

const assert = require('node:assert/strict')

const { getCypressDependencies } = require('./dependencies')

const sharedDependencies = [
  'cypress-fail-fast@7.1.0',
  'typescript@6.0.3',
]

describe('getCypressDependencies', () => {
  it('pins TypeScript 6 for Cypress versions using the bundled TypeScript loader', () => {
    assert.deepStrictEqual(getCypressDependencies('12.0.0'), [
      'cypress@12.0.0',
      ...sharedDependencies,
    ])
  })

  it('installs the Babel TypeScript preset required by latest Cypress', () => {
    assert.deepStrictEqual(getCypressDependencies('latest'), [
      'cypress@latest',
      ...sharedDependencies,
      '@babel/preset-typescript@7.28.5',
    ])
  })
})
