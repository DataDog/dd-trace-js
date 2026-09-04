import { carrierFieldsConfig } from '../eslint-rules/carrier-fields-policy.mjs'
import carrierFieldsRule from '../eslint-rules/eslint-carrier-fields.mjs'

const optionsURL = new URL(import.meta.url)
const cwd = optionsURL.searchParams.get('cwd')

if (cwd === null) throw new TypeError('The carrier fields ESLint options require a cwd')

export default {
  allowInlineConfig: false,
  cache: false,
  concurrency: 'auto',
  cwd,
  overrideConfigFile: true,
  overrideConfig: [
    {
      plugins: {
        'eslint-rules': {
          meta: {
            name: 'dd-trace/carrier-fields',
          },
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
}
