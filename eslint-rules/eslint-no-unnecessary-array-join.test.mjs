import { RuleTester } from 'eslint'

import rule from './eslint-no-unnecessary-array-join.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-no-unnecessary-array-join', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    "const parts = ['a']; parts.join('')",
    "const parts = []; parts.push('a'); consume(parts); parts.join('')",
    "const parts = []; parts.push('a'); parts.join(separator)",
    "const parts = []; parts.push('a'); parts.join(`$" + '{separator}`)',
    "const parts = []; parts.push('a'); parts.join(''); parts.join('')",
    "const parts = []; parts.join(''); parts.push('a')",
    "const parts = []; parts.push('a'); parts.pop(); parts.join('')",
    "const parts = []; if (parts.push('a')) consume(); parts.join('')",
    "const parts = []; parts['push']('a'); parts.join('')",
    "const parts = []; parts.push?.('a'); parts.join('')",
    "const parts = []; parts.push(...values); parts.join('')",
    "const parts = []; parts.push(); parts.join('')",
    "let parts = []; parts.push('a'); parts = []; parts.join('')",
    "var parts = []; var parts; parts.push('a'); parts.join('')",
    "const parts = []; parts[0] = 'a'; parts.join('')",
    `
      function build () {
        const parts = []
        function append () {
          parts.push('a')
        }
        append()
        return parts.join('')
      }
    `,
  ],
  invalid: [
    {
      code: "const parts = []; parts.push(value); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: 'const parts = []; parts.push(null); parts.join()',
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push('a'); parts.join(',')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push('a'); parts.join(``)",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: `
        function build (values) {
          const parts = []
          for (const value of values) {
            parts.push(\`\${value}\`)
          }
          return parts.join('')
        }
      `,
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: `
        function build (value, enabled) {
          const parts = []
          if (enabled) parts.push('prefix:', value + '')
          parts.push(enabled ? 'enabled' : 'disabled')
          return parts.join('')
        }
      `,
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: `
        const parts = []
        {
          const parts = []
          parts.push(value)
        }
        parts.push((consume(), 'value'))
        parts.join('')
      `,
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
  ],
})
