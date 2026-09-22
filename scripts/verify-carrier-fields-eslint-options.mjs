import { carrierFieldsConfig } from '../eslint-rules/carrier-fields-policy.mjs'
import carrierFieldsRule from '../eslint-rules/eslint-carrier-fields.mjs'

const optionsURL = new URL(import.meta.url)
const cwd = optionsURL.searchParams.get('cwd')

export default {
  allowInlineConfig: false,
  concurrency: 'auto',
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
}
