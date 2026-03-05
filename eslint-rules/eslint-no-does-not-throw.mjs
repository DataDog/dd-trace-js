export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow assert.doesNotThrow() calls. Instead, execute the ' +
        'function directly — if it throws, the test will fail.',
    },
    fixable: 'code',
    messages: {
      noDoesNotThrow:
        'Do not use assert.doesNotThrow(). Call the function directly ' +
        'instead — if it throws, the test will fail.',
    },
    schema: [],
  },
  create (context) {
    const doesNotThrowVars = new Set()

    return {
      VariableDeclarator (node) {
        // Track destructured imports:
        // const { doesNotThrow } = require('assert')
        if (node.id.type !== 'ObjectPattern') return

        for (const prop of node.id.properties) {
          if (
            prop.type === 'Property' &&
            prop.key.name === 'doesNotThrow'
          ) {
            doesNotThrowVars.add(prop.value.name)
          }
        }
      },

      CallExpression (node) {
        const isAssertMember =
          node.callee.type === 'MemberExpression' &&
          node.callee.property.name === 'doesNotThrow'

        const isDestructured =
          node.callee.type === 'Identifier' &&
          doesNotThrowVars.has(node.callee.name)

        if (!isAssertMember && !isDestructured) return

        const sourceCode = context.sourceCode ?? context.getSourceCode()

        context.report({
          node,
          messageId: 'noDoesNotThrow',
          fix (fixer) {
            const arg = node.arguments[0]
            if (!arg) return null

            const replacement = buildReplacement(arg, sourceCode)
            if (!replacement) return null

            // Determine what to replace: the full ExpressionStatement
            // if the doesNotThrow call is the only expression, so we
            // remove the entire statement cleanly.
            const stmt = node.parent
            if (stmt?.type === 'ExpressionStatement') {
              return fixer.replaceText(stmt, replacement)
            }
            return fixer.replaceText(node, replacement)
          },
        })
      },
    }
  },
}

/**
 * Build the replacement text for a doesNotThrow argument.
 *
 * Arrow/function with expression body:
 *   assert.doesNotThrow(() => expr) → expr
 *
 * Arrow/function with block body (single statement):
 *   assert.doesNotThrow(() => { stmt }) → stmt
 *
 * Arrow/function with block body (multiple statements):
 *   assert.doesNotThrow(() => { a; b }) → a\nb
 *
 * Function reference:
 *   assert.doesNotThrow(fn) → fn()
 *   assert.doesNotThrow(obj.method) → obj.method()
 */
function buildReplacement (arg, sourceCode) {
  // Arrow function or function expression
  if (
    arg.type === 'ArrowFunctionExpression' ||
    arg.type === 'FunctionExpression'
  ) {
    // Expression body: () => expr
    if (arg.body.type !== 'BlockStatement') {
      return sourceCode.getText(arg.body)
    }

    // Block body: () => { ... }
    const stmts = arg.body.body
    if (stmts.length === 0) return null

    const parts = []
    for (const s of stmts) {
      parts.push(sourceCode.getText(s))
    }
    return parts.join('\n')
  }

  // Function reference: fn or obj.method
  if (
    arg.type === 'Identifier' ||
    arg.type === 'MemberExpression'
  ) {
    return sourceCode.getText(arg) + '()'
  }

  return null
}
