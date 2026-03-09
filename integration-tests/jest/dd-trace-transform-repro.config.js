'use strict'

const path = require('path')

const { sharedOptions } = require('./transform-config-identity/shared-options')

module.exports = {
  rootDir: path.join(__dirname, '..'),
  cache: false,
  collectCoverage: true,
  coverageProvider: 'babel',
  testEnvironment: 'node',
  testEnvironmentOptions: sharedOptions,
  testMatch: ['**/jest/transform-config-identity/**/*.test.ts'],
  transform: {
    '^.+\\.[jt]sx?$': '<rootDir>/jest/transform-config-identity/custom-transformer.js',
  },
}
