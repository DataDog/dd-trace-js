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
    "const parts = []; parts.push('a')",
    "const parts = []; parts.join('')",
    "const parts = []; parts.join(''); parts.push('a')",
    "const parts = []; parts.push('a'); parts.pop(); parts.join('')",
    "const parts = []; if (parts.push('a')) consume(); parts.join('')",
    "const parts = []; parts['push']('a'); parts.join('')",
    "const parts = []; parts.push?.('a'); parts.join('')",
    "const parts = []; parts.push(...values); parts.join('')",
    "const parts = []; parts.push(); parts.join('')",
    'const parts = []; parts.push(null); parts.join()',
    "const parts = []; parts.push(undefined); parts.join('')",
    "const parts = []; parts.push(42); parts.join('')",
    "const parts = []; parts.push({}); parts.join('')",
    "const parts = []; parts.push([]); parts.join('')",
    "const parts = []; parts.push(new Date()); parts.join('')",
    "const parts = []; parts.push(() => 'value'); parts.join('')",
    "const parts = []; parts.push(enabled ? 'enabled' : null); parts.join('')",
    "const parts = []; parts.push(value * 2); parts.join('')",
    "let value = 1; const parts = []; parts.push(value++); parts.join('')",
    `
      const parts = []
      const value = { toString () { return state } }
      parts.push(value)
      state = 'changed'
      parts.join('')
    `,
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
      code: "const parts = []; parts.push('a'); parts.join()",
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
      code: "const parts = []; parts.push('a' || 'b'); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push(value); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const value = 'a'; const parts = []; parts.push(value); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push(value.text); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push(JSON.stringify(value)); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push(enabled ? 'enabled' : value); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push('enabled' && value); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push((consume(), value)); parts.join('')",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'parts' } }],
    },
    {
      code: "const parts = []; parts.push(typeof value); parts.join('')",
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
