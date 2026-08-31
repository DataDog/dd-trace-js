import { pathToFileURL } from 'node:url'

import { ESLint } from 'eslint'

import { carrierFieldsConfig, carrierFieldsFilePatterns } from '../eslint-rules/carrier-fields-policy.mjs'
import carrierFieldsRule from '../eslint-rules/eslint-carrier-fields.mjs'

/**
 * @param {string} cwd
 * @returns {ESLint}
 */
export function createCarrierFieldsEslint (cwd = process.cwd()) {
  return new ESLint({
    allowInlineConfig: false,
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        plugins: {
          'eslint-rules': {
            rules: { 'eslint-carrier-fields': carrierFieldsRule },
          },
        },
      },
      {
        files: ['packages/*/src/**/*.js'],
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: 'commonjs',
        },
      },
      ...carrierFieldsConfig,
    ],
  })
}

/**
 * @param {string} cwd
 * @returns {Promise<number>}
 */
export async function verifyCarrierFields (cwd = process.cwd()) {
  const eslint = createCarrierFieldsEslint(cwd)
  const results = await eslint.lintFiles(carrierFieldsFilePatterns)
  const errors = ESLint.getErrorResults(results)

  if (errors.length === 0) return 0

  const formatter = await eslint.loadFormatter('stylish')
  // eslint-disable-next-line no-console
  console.error(await formatter.format(errors))
  return 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await verifyCarrierFields()
}
