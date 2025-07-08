// The content of this file is inspired from the following rule:
// https://github.com/liferay/liferay-frontend-projects/blob/master/projects/eslint-plugin/rules/general/lib/rules/no-typeof-object.js

export default {
  meta: {
    type: 'problem',
    docs: {
      description: "Ensure that `typeof x === 'object'` checks are guarded against not-null values",
      recommended: true
    },
    fixable: 'code',
    schema: [],
  },

  create (context) {
    return {
      BinaryExpression (node) {
        if (
          node.left?.type === 'UnaryExpression' &&
          node.left.operator === 'typeof' &&
          node.operator === '===' &&
          node.right?.value === 'object'
        ) {
          // Get the expression being checked (x or x.y)
          const targetExpression = getSourceText(context, node.left.argument)

          let hasNullCheck = false

          // First check if there's a null guard at the immediate AND level
          let current = node.parent
          if (current && current.type === 'LogicalExpression' && current.operator === '&&') {
            const conditions = collectAndConditions(current)
            hasNullCheck = conditions.some(condition =>
              condition !== node && isNullCheck(condition, targetExpression, context)
            )
          }

          // If not found at immediate level, check broader logical expression
          if (!hasNullCheck) {
            current = node.parent
            let rootLogicalExpression = null

            // Find the root of any logical expression chain
            while (current && current.type === 'LogicalExpression') {
              rootLogicalExpression = current
              current = current.parent
            }

            if (rootLogicalExpression) {
              // Collect all conditions in the AND chain
              const conditions = collectAndConditions(rootLogicalExpression)

              // Check if any condition is a null check for our variable
              hasNullCheck = conditions.some(condition =>
                condition !== node && isNullCheck(condition, targetExpression, context)
              )
            }
          }

          if (!hasNullCheck) {
            context.report({
              fix (fixer) {
                return fixer.insertTextBefore(node, `${targetExpression} !== null && `)
              },
              message: `"typeof ${targetExpression} === 'object'" missing not-null guard`,
              node
            })
          }
        }
      }
    }
  }
}

// Helper function to get source text of a node
function getSourceText (context, node) {
  return context.getSourceCode().getText(node)
}

// Helper function to collect all conditions from a logical AND chain
function collectAndConditions (node) {
  const conditions = []

  function traverse (node) {
    if (node.type === 'LogicalExpression' && node.operator === '&&') {
      traverse(node.left)
      traverse(node.right)
    } else {
      // Don't traverse into OR expressions, just add them as a whole condition
      conditions.push(node)
    }
  }

  traverse(node)

  return conditions
}

// Helper function to check if a condition is a null check for the given variable
function isNullCheck (condition, targetExpression, context) {
  // Check for x !== null or x.y !== null
  if (
    condition.type === 'BinaryExpression' &&
    condition.operator === '!==' &&
    condition.right?.value === null &&
    getSourceText(context, condition.left) === targetExpression
  ) {
    return true
  }

  // Check for x (truthy check) or x.y (truthy check)
  if (getSourceText(context, condition) === targetExpression) {
    return true
  }

  // Check for !!x (boolean conversion check) or !!x.y
  if (
    condition.type === 'UnaryExpression' &&
    condition.operator === '!' &&
    condition.argument?.type === 'UnaryExpression' &&
    condition.argument.operator === '!' &&
    getSourceText(context, condition.argument.argument) === targetExpression
  ) {
    return true
  }

  return false
}
