'use strict'

const { createTransformer } = require('babel-jest')

const { SecretOptions } = require('./shared-options')

const babelJestTransformer = createTransformer({
  presets: ['@babel/preset-typescript'],
})

module.exports = {
  process (sourceText, sourcePath, transformOptions) {
    const preservesTestEnvironmentOptionsPrototype =
      transformOptions.config.testEnvironmentOptions instanceof SecretOptions

    if (!preservesTestEnvironmentOptionsPrototype) {
      throw new Error('testEnvironmentOptions prototype was lost before Babel transform')
    }

    return babelJestTransformer.process(sourceText, sourcePath, transformOptions)
  },
}
