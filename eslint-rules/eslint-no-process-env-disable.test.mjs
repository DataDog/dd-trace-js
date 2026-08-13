import path from 'node:path'

import { RuleTester } from 'eslint'

import noProcessEnvDisable from './eslint-no-process-env-disable.mjs'
import processEnv from './eslint-process-env.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
  linterOptions: { reportUnusedDisableDirectives: false },
  plugins: {
    'eslint-rules': {
      rules: {
        'eslint-process-env': processEnv,
      },
    },
  },
  rules: {
    'eslint-rules/eslint-process-env': 'error',
  },
})

ruleTester.run('eslint-no-process-env-disable', noProcessEnvDisable, {
  valid: [
    '// eslint-disable-next-line no-console\nconsole.log("message")',
    '// eslint-enable eslint-rules/eslint-process-env',
    {
      code: '// eslint-disable-next-line eslint-rules/eslint-process-env\nprocess.env.CI',
      filename: path.join(process.cwd(), 'ci/init.js'),
      options: [{ allowFiles: ['ci/init.js'] }],
    },
    {
      code: '/* eslint-disable no-console, eslint-rules/eslint-process-env */\nprocess.env.CI',
      filename: path.join(process.cwd(), 'ci/diagnose.js'),
      options: [{ allowFiles: ['ci/diagnose.js'] }],
    },
  ],
  invalid: [
    {
      code: '// eslint-disable-next-line eslint-rules/eslint-process-env\nprocess.env.CI',
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: '/* eslint-disable eslint-rules/eslint-process-env */\nprocess.env.CI',
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: 'process.env.CI // eslint-disable-line eslint-rules/eslint-process-env',
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: '/* eslint-disable no-console, eslint-rules/eslint-process-env */\nprocess.env.CI',
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: '// eslint-disable-next-line eslint-rules/eslint-process-env -- requires raw input\nprocess.env.CI',
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: [
        '// eslint-disable-next-line eslint-rules/eslint-process-env',
        'process.env.CI',
        '// eslint-disable-next-line eslint-rules/eslint-process-env',
        'process.env.NODE_ENV',
      ].join('\n'),
      filename: path.join(process.cwd(), 'ci/init.js'),
      options: [{ allowFiles: ['ci/init.js'] }],
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
    {
      code: '// eslint-disable-next-line eslint-rules/eslint-process-env\nprocess.env.CI',
      filename: path.join(process.cwd(), 'packages/example/src/ci/init.js'),
      options: [{ allowFiles: ['ci/init.js'] }],
      errors: [{ messageId: 'noProcessEnvDisable' }],
    },
  ],
})
