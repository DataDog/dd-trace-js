'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getBabelDependencies } = require('./babel-dependencies')

const babel7Dependencies = [
  '@babel/core@7.29.0',
  '@babel/preset-typescript@7.28.5',
]

describe('getBabelDependencies', () => {
  it('uses Babel 7 pins when Node.js does not support Babel 8', () => {
    assert.deepStrictEqual(getBabelDependencies('latest', '18.20.8'), babel7Dependencies)
  })

  it('uses Babel 7 pins when Jest is not latest', () => {
    assert.deepStrictEqual(getBabelDependencies('28.0.0', '22.22.3'), babel7Dependencies)
  })

  it('uses Babel 7 pins before the Node.js 24 version supported by Babel 8', () => {
    assert.deepStrictEqual(getBabelDependencies('latest', '24.10.0'), babel7Dependencies)
  })

  it('uses the unversioned Babel entries when Node.js and Jest support Babel 8', () => {
    assert.deepStrictEqual(getBabelDependencies('latest', '22.22.3'), [
      '@babel/core',
      '@babel/preset-typescript',
    ])
  })
})
