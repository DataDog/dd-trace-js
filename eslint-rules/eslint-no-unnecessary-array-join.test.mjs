import { RuleTester } from 'eslint'

import rule from './eslint-no-unnecessary-array-join.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-no-unnecessary-array-join', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    "const parts = ['a']; parts.join('')",
    "const parts = ['a']; parts.join(separator)",
    "const text = ['first', 'second'].join('\\n')",
    {
      code: "[...parts].join('')",
      options: [{ reportLiteralArrayJoins: true }],
    },
    {
      code: "['first',, 'second'].join('')",
      options: [{ reportLiteralArrayJoins: true }],
    },
    "messages.map(message => message.text).join('')",
    {
      code: "messages.map(message => message.text, receiver).join('')",
      options: [{ reportMapJoinChains: true }],
    },
    {
      code: "const Boolean = value => value; ['receive', source].filter(Boolean).join(' ')",
      options: [{ reportLiteralArrayJoins: true }],
    },
    {
      code: "[first, second, third].filter(Boolean).join(' ')",
      options: [{ reportLiteralArrayJoins: true }],
    },
    "const parts = []; parts.push('a'); consume(parts); parts.join('')",
    "const parts = []; parts.push('a'); consume(parts.length); parts.join('')",
    "const parts = []; parts.push('a'); if (parts.length > 1) consume(parts.join(', '))",
    "const parts = []; parts.push('a'); parts.length = 0; parts.join('')",
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
      function appendNothing (parts) {}
      const parts = []
      parts.push('value')
      appendNothing(parts)
      parts.join('')
    `,
    `
      function appendNull (parts) {
        parts.push(null)
      }
      const parts = []
      appendNull(parts)
      parts.join('')
    `,
    `
      async function appendValue (parts) {
        parts.push('value')
      }
      const parts = []
      appendValue(parts)
      parts.join('')
    `,
    `
      function * appendValue (parts) {
        parts.push('value')
      }
      const parts = []
      appendValue(parts)
      parts.join('')
    `,
    `
      function appendEmptyTag (parts) {
        parts.push()
      }
      function build () {
        const parts = []
        appendEmptyTag(parts)
        return parts.join('')
      }
    `,
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
    `
      function appendValue (parts) {
        parts.push('a')
      }
      function build () {
        const parts = []
        function append () {
          appendValue(parts)
        }
        append()
        return parts.join('')
      }
    `,
  ],
  invalid: [
    {
      code: "[this.constructor.name, generateStream.name].join('.')",
      options: [{ reportLiteralArrayJoins: true }],
      errors: [{ messageId: 'buildLiteralStringDirectly' }],
    },
    {
      code: `
        const body = isEsm
          ? [
              \`import originalConfig from \${JSON.stringify(pathToFileURL(originalConfigFile).href)}\`,
              \`import cypressConfig from \${JSON.stringify(pathToFileURL(cypressConfigPath).href)}\`,
              '',
              'export default cypressConfig.wrapConfig(originalConfig)',
              '',
            ].join('\\n')
          : [
              \`const cypressConfig = require(\${JSON.stringify(cypressConfigPath)})\`,
              \`const originalExports = require(\${JSON.stringify(originalConfigFile)})\`,
              'const originalConfig = originalExports && originalExports.__esModule',
              '  ? originalExports.default',
              '  : originalExports',
              'module.exports = cypressConfig.wrapConfig(originalConfig)',
              '',
            ].join('\\n')
      `,
      options: [{ reportLiteralArrayJoins: true }],
      errors: [
        { messageId: 'buildLiteralStringDirectly' },
        { messageId: 'buildLiteralStringDirectly' },
      ],
    },
    {
      code: `
        function appendLogTag (tags, key, value) {
          if (value !== undefined) tags.push(\`\${key}:\${value}\`)
        }
        function getLogTags (logMessage) {
          const tags = []
          if (Array.isArray(logMessage.ddtags)) {
            for (const tag of logMessage.ddtags) tags.push(tag)
          }
          appendLogTag(tags, 'env', 'ci')
          return tags.join(',')
        }
      `,
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'tags' } }],
    },
    {
      code: "new RegExp([NUMERIC_LITERAL, STRING_LITERAL, LINE_COMMENT].join('|'), 'gmi')",
      options: [{ reportLiteralArrayJoins: true }],
      errors: [{ messageId: 'buildLiteralStringDirectly' }],
    },
    {
      code: "['receive', source].filter(Boolean).join(' ')",
      options: [{ reportLiteralArrayJoins: true }],
      errors: [{ messageId: 'buildLiteralStringDirectly' }],
    },
    {
      code: `
        const content = messages
          .filter(message => message.type === 'text')
          .map(message => message.text)
          .join('')
      `,
      options: [{ reportMapJoinChains: true }],
      errors: [{ messageId: 'buildMappedStringDirectly' }],
    },
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
        function build (values) {
          const aliases = []
          for (const value of values) {
            aliases.push(\`\${value} = source\`)
          }
          if (aliases.length > 0) {
            consume(aliases.join(', '))
          }
        }
      `,
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'aliases' } }],
    },
    {
      code: "const aliases = []; aliases.push('value'); if (0 < aliases.length) consume(aliases.join(', '))",
      errors: [{ messageId: 'buildStringDirectly', data: { name: 'aliases' } }],
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
