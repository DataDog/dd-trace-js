import path from 'node:path'

const UTIL_MODULE = 'datadog-core/src/utils/src/is-empty-object'

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Avoid Object.keys(x).length for emptiness checks — it allocates ' +
        'an intermediate array. Use isEmptyObject() instead.',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      noObjectKeysLength:
        'Avoid Object.keys(x).length for emptiness checks — it allocates ' +
        'an intermediate array. Use isEmptyObject() instead.',
    },
    schema: [],
  },

  create (context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()
    let hasIsEmptyObjectRequire = false
    let lastRequireNode = null

    return {
      // Track existing top-level require statements to know where to
      // insert and whether isEmptyObject is already imported
      CallExpression (node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal'
        ) {
          if (node.arguments[0].value?.endsWith('is-empty-object')) {
            hasIsEmptyObjectRequire = true
          }
          // Only track top-level requires for insertion point
          const stmt = node.parent?.type === 'VariableDeclarator'
            ? node.parent.parent
            : node.parent
          if (isTopLevelStatement(stmt, sourceCode)) {
            lastRequireNode = stmt
          }
        }
      },

      MemberExpression (node) {
        if (!isObjectKeysValuesEntriesLength(node)) return
        if (!isUsedForEmptinessCheck(node)) return

        const innerArg = node.object.arguments[0]
        const argText = sourceCode.getText(innerArg)

        context.report({
          messageId: 'noObjectKeysLength',
          node: getReportNode(node),
          fix (fixer) {
            const requirePath = computeRequirePath(context)
            if (!requirePath) return null

            const fixes = []
            const { replacement, replaceNode } = buildReplacement(
              node, argText,
            )
            if (!replacement || !replaceNode) return null

            fixes.push(fixer.replaceText(replaceNode, replacement))

            if (!hasIsEmptyObjectRequire) {
              const requireStatement =
                `const isEmptyObject = require('${requirePath}')\n`
              if (lastRequireNode) {
                fixes.push(
                  fixer.insertTextAfter(
                    lastRequireNode, '\n' + requireStatement,
                  ),
                )
              } else {
                const insertAfter = findUseStrictNode(sourceCode)
                if (insertAfter) {
                  fixes.push(
                    fixer.insertTextAfter(
                      insertAfter, '\n' + requireStatement,
                    ),
                  )
                } else {
                  const firstToken = sourceCode.ast.body[0]
                  if (firstToken) {
                    fixes.push(
                      fixer.insertTextBefore(
                        firstToken, requireStatement + '\n',
                      ),
                    )
                  }
                }
              }
              hasIsEmptyObjectRequire = true
            }

            return fixes
          },
        })
      },
    }
  },
}

function isCallToObjectMethod (node, methodName) {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'Object' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === methodName &&
    !node.callee.computed
  )
}

function isObjectKeysValuesEntriesLength (node) {
  if (node.type !== 'MemberExpression' || node.computed) return false
  if (node.property?.type !== 'Identifier' || node.property.name !== 'length') {
    return false
  }
  const obj = node.object
  return (
    isCallToObjectMethod(obj, 'keys') ||
    isCallToObjectMethod(obj, 'values') ||
    isCallToObjectMethod(obj, 'entries')
  )
}

function isEmptinessComparison (operator, rightNode) {
  if (!rightNode || rightNode.type !== 'Literal') return false
  const val = rightNode.value

  // .length === 0, .length == 0, .length !== 0, .length != 0
  if ((operator === '===' || operator === '==' ||
       operator === '!==' || operator === '!=') && val === 0) {
    return true
  }
  // .length > 0
  if (operator === '>' && val === 0) return true
  // .length < 1
  if (operator === '<' && val === 1) return true

  return false
}

function isUsedForEmptinessCheck (node) {
  const parent = node.parent
  if (!parent) return false

  if (parent.type === 'BinaryExpression') {
    if (parent.left === node && isEmptinessComparison(parent.operator, parent.right)) {
      return true
    }
  }

  if (parent.type === 'UnaryExpression' && parent.operator === '!') {
    return true
  }

  let current = node
  let curr = node.parent
  while (curr) {
    if (curr.type === 'IfStatement' && curr.test === current) return true
    if (curr.type === 'ConditionalExpression' && curr.test === current) {
      return true
    }
    if (curr.type === 'LogicalExpression') {
      current = curr
      curr = curr.parent
      continue
    }
    break
  }

  return false
}

/**
 * Get the node to report and potentially replace — walks up to the
 * BinaryExpression or UnaryExpression that contains the emptiness check.
 */
function getReportNode (lengthNode) {
  const parent = lengthNode.parent
  if (parent.type === 'BinaryExpression' && parent.left === lengthNode) {
    return parent
  }
  if (parent.type === 'UnaryExpression' && parent.operator === '!') {
    return parent
  }
  return lengthNode
}

/**
 * Compute the replacement text for the emptiness check expression.
 *
 * Object.keys(x).length === 0  →  isEmptyObject(x)
 * Object.keys(x).length !== 0  →  !isEmptyObject(x)
 * Object.keys(x).length > 0    →  !isEmptyObject(x)
 * Object.keys(x).length < 1    →  isEmptyObject(x)
 * Object.keys(x).length == 0   →  isEmptyObject(x)
 * Object.keys(x).length != 0   →  !isEmptyObject(x)
 * !Object.keys(x).length       →  isEmptyObject(x)
 * Object.keys(x).length        →  !isEmptyObject(x)  (truthy context)
 */
function buildReplacement (lengthNode, argText) {
  const parent = lengthNode.parent

  if (parent.type === 'BinaryExpression' && parent.left === lengthNode) {
    const right = parent.right
    const isZero = right?.type === 'Literal' && right.value === 0
    const isOne = right?.type === 'Literal' && right.value === 1

    switch (parent.operator) {
      case '===':
      case '==':
        if (isZero) {
          return { replacement: `isEmptyObject(${argText})`, replaceNode: parent }
        }
        break
      case '!==':
      case '!=':
        if (isZero) {
          return { replacement: `!isEmptyObject(${argText})`, replaceNode: parent }
        }
        break
      case '>':
        if (isZero) {
          return { replacement: `!isEmptyObject(${argText})`, replaceNode: parent }
        }
        break
      case '<':
        if (isOne) {
          return { replacement: `isEmptyObject(${argText})`, replaceNode: parent }
        }
        break
    }
    return {}
  }

  // !Object.keys(x).length → isEmptyObject(x)
  if (parent.type === 'UnaryExpression' && parent.operator === '!') {
    return { replacement: `isEmptyObject(${argText})`, replaceNode: parent }
  }

  // Object.keys(x).length in boolean context → !isEmptyObject(x)
  return { replacement: `!isEmptyObject(${argText})`, replaceNode: lengthNode }
}

/**
 * Check whether an AST node is a top-level statement (direct child of
 * the Program body). Requires nested inside functions, methods, or
 * class constructors are ignored for require-insertion purposes.
 */
function isTopLevelStatement (node, sourceCode) {
  if (!node) return false
  const program = sourceCode.ast
  return program.body.includes(node)
}

/**
 * Find the 'use strict' directive at the top of the file, if any.
 * Returns the ExpressionStatement node so the require can be inserted
 * after it.
 */
function findUseStrictNode (sourceCode) {
  const first = sourceCode.ast.body[0]
  if (
    first?.type === 'ExpressionStatement' &&
    first.expression?.type === 'Literal' &&
    first.expression.value === 'use strict'
  ) {
    return first
  }
  return null
}

/**
 * Compute the relative require path from the current file to the shared
 * isEmptyObject utility. Returns null if the file is outside the packages/
 * directory (auto-fix not supported).
 */
function computeRequirePath (context) {
  const filename = context.filename ?? context.getFilename()
  if (!filename || filename === '<input>') return null

  const packagesIdx = filename.lastIndexOf('/packages/')
  if (packagesIdx === -1) return null

  const fromDir = path.dirname(filename)
  const root = filename.slice(0, packagesIdx)
  const utilAbsolute = path.join(root, 'packages', UTIL_MODULE)
  const relative = path.relative(fromDir, utilAbsolute)

  // Ensure it starts with ./ or ../
  if (!relative.startsWith('.')) {
    return './' + relative
  }
  return relative
}
