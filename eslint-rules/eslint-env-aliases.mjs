import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)

const supportedConfigsPath = path.resolve(
  path.dirname(__filename),
  '../packages/dd-trace/src/supported-configurations.json'
)
const { aliases } = JSON.parse(fs.readFileSync(supportedConfigsPath, 'utf8'))

const aliasToCanonical = {}
for (const canonical of Object.keys(aliases)) {
  for (const alias of aliases[canonical]) {
    aliasToCanonical[alias] = canonical
  }
}

function report (context, node, alias) {
  const canonical = aliasToCanonical[alias]
  context.report({
    node,
    message: `Use canonical environment variable name '${canonical}' instead of alias '${alias}'`,
    fix (fixer) {
      return fixer.replaceText(node, `'${canonical}'`)
    }
  })
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow usage of environment variable aliases instead of canonical names'
    },
    fixable: 'code',
    schema: []
  },
  create (context) {
    return {
      Literal (node) {
        // Check if the string literal is an alias
        if (typeof node.value === 'string' && Object.hasOwn(aliasToCanonical, node.value)) {
          report(context, node, node.value)
        }
      },

      // Also check for template literals when they contain only a string
      TemplateLiteral (node) {
        if (node.expressions.length === 0 && node.quasis.length === 1) {
          const value = node.quasis[0].value.cooked
          if (Object.hasOwn(aliasToCanonical, value)) {
            report(context, node, value)
          }
        }
      }
    }
  }
}
