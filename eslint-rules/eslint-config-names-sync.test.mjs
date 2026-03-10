import path from 'node:path'

import { RuleTester } from 'eslint'

import rule from './eslint-config-names-sync.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
})

const fixturesDirectory = path.join(process.cwd(), 'eslint-rules/fixtures/config-names-sync')

/**
 * @param {string} fixtureName
 * @returns {{ indexDtsPath: string, supportedConfigurationsPath: string }}
 */
function getFixtureOptions (fixtureName) {
  const fixtureDirectory = path.join(fixturesDirectory, fixtureName)

  return {
    indexDtsPath: path.relative(process.cwd(), path.join(fixtureDirectory, 'index.d.ts')),
    supportedConfigurationsPath: path.relative(
      process.cwd(),
      path.join(fixtureDirectory, 'supported-configurations.json')
    ),
  }
}

ruleTester.run('eslint-config-names-sync', rule, {
  valid: [
    {
      filename: path.join(fixturesDirectory, 'valid', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('valid')],
    },
    {
      filename: path.join(fixturesDirectory, 'trace-propagation-style-exception', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('trace-propagation-style-exception')],
    },
    {
      filename: path.join(fixturesDirectory, 'internal-env-and-ignored-names', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('internal-env-and-ignored-names')],
    },
  ],
  invalid: [
    {
      filename: path.join(fixturesDirectory, 'missing-in-index-dts', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('missing-in-index-dts')],
      errors: [{
        messageId: 'configurationMissingInIndexDts',
        data: {
          configurationName: 'missingFromTypes',
        },
      }],
    },
    {
      filename: path.join(fixturesDirectory, 'missing-in-supported-configurations', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('missing-in-supported-configurations')],
      errors: [{
        messageId: 'configurationMissingInSupportedConfigurations',
        data: {
          configurationName: 'missingFromJson',
        },
      }],
    },
    {
      filename: path.join(fixturesDirectory, 'missing-nested-leaf-in-supported-configurations', 'lint-anchor.js'),
      code: '',
      options: [getFixtureOptions('missing-nested-leaf-in-supported-configurations')],
      errors: [{
        messageId: 'configurationMissingInSupportedConfigurations',
        data: {
          configurationName: 'llmobs.agentlessEnabledasd',
        },
      }],
    },
  ],
})
