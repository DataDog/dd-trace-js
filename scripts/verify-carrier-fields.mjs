import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ESLint } from 'eslint'

import carrierFieldsRule from '../eslint-rules/eslint-carrier-fields.mjs'

const SOURCE_ROOT = 'packages'

/**
 * @param {string} directory
 * @param {string[]} files
 * @returns {string[]}
 */
function collectJavaScriptFiles (directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectJavaScriptFiles(filename, files)
    } else if (entry.isFile() && /\.[cm]?js$/.test(entry.name) && filename.includes(`${path.sep}src${path.sep}`)) {
      files.push(filename)
    }
  }
  return files
}

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
        files: ['packages/*/src/**/*.{js,mjs,cjs}'],
        plugins: {
          'carrier-fields-verifier': {
            rules: {
              'carrier-fields': carrierFieldsRule,
            },
          },
        },
        rules: {
          'carrier-fields-verifier/carrier-fields': ['error', { requireDirectOperations: true }],
        },
      },
      {
        files: ['packages/*/src/**/*.{js,cjs}'],
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: 'commonjs',
        },
      },
      {
        files: ['packages/*/src/**/*.mjs'],
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
        },
      },
      {
        files: [
          'packages/dd-trace/src/datastreams/pathway.js',
          'packages/dd-trace/src/opentracing/propagation/text_map.js',
        ],
        rules: {
          'carrier-fields-verifier/carrier-fields': ['error', {
            requireDirectOperations: true,
            strictCarrierIdentifiers: true,
          }],
        },
      },
    ],
  })
}

/**
 * @param {string} cwd
 * @returns {Promise<number>}
 */
export async function verifyCarrierFields (cwd = process.cwd()) {
  const eslint = createCarrierFieldsEslint(cwd)
  const files = collectJavaScriptFiles(path.join(cwd, SOURCE_ROOT))
  const results = await eslint.lintFiles(files)
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
