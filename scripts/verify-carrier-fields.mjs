import { pathToFileURL } from 'node:url'

import { ESLint } from 'eslint'

import { carrierFieldsFilePatterns } from '../eslint-rules/carrier-fields-policy.mjs'

/**
 * @param {string} cwd
 * @returns {Promise<ESLint>}
 */
export function createCarrierFieldsEslint (cwd = process.cwd()) {
  const optionsURL = new URL('verify-carrier-fields-eslint-options.mjs', import.meta.url)
  optionsURL.searchParams.set('cwd', cwd)
  return ESLint.fromOptionsModule(optionsURL)
}

/**
 * @param {string} cwd
 * @returns {Promise<number>}
 */
export async function verifyCarrierFields (cwd = process.cwd()) {
  const eslint = await createCarrierFieldsEslint(cwd)
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
