'use strict'

const { createTransformer } = require('babel-jest')

const { SecretOptions } = require('./shared-options')

const babelJestTransformer = createTransformer({
  presets: ['@babel/preset-typescript'],
})

module.exports = {
  process (sourceText, sourcePath, configOrTransformOptions, legacyTransformOptions) {
    // Jest <=24 passes the project config as the third argument. Newer versions
    // pass a transform options object with the config nested inside `config`.
    const jestConfig = legacyTransformOptions
      ? configOrTransformOptions
      : configOrTransformOptions?.config ?? configOrTransformOptions

    const preservesTestEnvironmentOptionsPrototype =
      jestConfig?.testEnvironmentOptions instanceof SecretOptions

    if (!preservesTestEnvironmentOptionsPrototype) {
      throw new Error('testEnvironmentOptions prototype was lost before Babel transform')
    }

    return babelJestTransformer.process.apply(babelJestTransformer, arguments)
  },
}
