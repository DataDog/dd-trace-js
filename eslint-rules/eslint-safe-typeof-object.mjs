// The content of this file is inspired from the following rule:
// https://github.com/liferay/liferay-frontend-projects/blob/master/projects/eslint-plugin/rules/general/lib/rules/no-typeof-object.js

export default {
  meta: {
    type: 'problem',
    docs: {
      description: "Ensure that `typeof x === 'object'` checks are guarded against not-null values",
      recommended: true,
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
          const targetNode = node.left.argument
          const targetExpression = getSourceText(context, targetNode)

          let hasNullCheck = false

          // First check if there's a null guard at the immediate AND level
          let current = node.parent
          if (current && current.type === 'LogicalExpression' && current.operator === '&&') {
            const conditions = collectAndConditions(current)
            hasNullCheck = conditions.some(condition =>
              condition !== node && isNullGuard(condition, targetNode, context)
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
                condition !== node && isNullGuard(condition, targetNode, context)
              )
            }
          }

          // If still not found, allow conditional guards like:
          // - x != null ? typeof x === 'object' : false
          // - x == null ? false : typeof x === 'object'
          if (!hasNullCheck) {
            const parent = node.parent

            if (parent?.type === 'ConditionalExpression') {
              if (parent.consequent === node) {
                hasNullCheck = isNotNullTest(parent.test, targetNode, context)
              } else if (parent.alternate === node) {
                hasNullCheck = isNullTest(parent.test, targetNode, context)
              }
            }
          }

          // If still not found, allow control-flow guards inside methods, like:
          // - if (x === null) return; ... typeof x === 'object'
          // - if (x == null) { throw ... } ... typeof x === 'object'
          // - if (x == null) { ... } else { typeof x === 'object' }
          if (!hasNullCheck) {
            hasNullCheck = isGuardedByIfStatement(node, targetNode, context) ||
              isGuaranteedNotNullByPriorStatements(node, targetNode, context)
          }

          if (!hasNullCheck) {
            context.report({
              fix (fixer) {
                return fixer.insertTextBefore(node, `${targetExpression} !== null && `)
              },
              message: `"typeof ${targetExpression} === 'object'" missing not-null guard`,
              node,
            })
          }
        }
      },
    }
  },
}

// Helper function to get source text of a node
function getSourceText (context, node) {
  return context.getSourceCode().getText(node)
}

function unwrapChainExpression (node) {
  return node?.type === 'ChainExpression' ? node.expression : node
}

function isSameReference (a, b) {
  a = unwrapChainExpression(a)
  b = unwrapChainExpression(b)

  if (!a || !b || a.type !== b.type) return false

  if (a.type === 'Identifier') {
    return a.name === b.name
  }

  if (a.type === 'ThisExpression') {
    return true
  }

  if (a.type === 'MemberExpression') {
    if (a.computed !== b.computed) return false
    if (!isSameReference(a.object, b.object)) return false

    if (a.computed) {
      // Keep this intentionally conservative: only accept the exact same property expression.
      // (This still eliminates most false-positives from formatting/comments/parentheses.)
      return a.property?.type === b.property?.type &&
        getPropertyKey(a.property) === getPropertyKey(b.property)
    }

    return b.property?.type === 'Identifier' && a.property?.name === b.property?.name
  }

  return false
}

function getPropertyKey (node) {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') return node.value
  return undefined
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

// Helper function to check if an expression acts as a "not-null guard" for the target reference.
function isNullGuard (condition, targetNode, context) {
  condition = unwrapChainExpression(condition)

  // Check for x !== null, x != null, null !== x, null != x (and member-expression variants)
  if (
    condition.type === 'BinaryExpression' &&
    (condition.operator === '!==' || condition.operator === '!=') &&
    (
      (
        condition.right?.type === 'Literal' &&
        condition.right.value === null &&
        isSameReference(condition.left, targetNode)
      ) ||
      (
        condition.left?.type === 'Literal' &&
        condition.left.value === null &&
        isSameReference(condition.right, targetNode)
      )
    )
  ) {
    return true
  }

  // Check for x (truthy check) or x.y (truthy check)
  if (isSameReference(condition, targetNode)) {
    return true
  }

  // Check for !!x (boolean conversion check) or !!x.y
  if (
    condition.type === 'UnaryExpression' &&
    condition.operator === '!' &&
    condition.argument?.type === 'UnaryExpression' &&
    condition.argument.operator === '!' &&
    isSameReference(condition.argument.argument, targetNode)
  ) {
    return true
  }

  // Check for Boolean(x) or Boolean(x.y)
  if (
    condition.type === 'CallExpression' &&
    condition.callee?.type === 'Identifier' &&
    condition.callee.name === 'Boolean' &&
    condition.arguments?.length === 1 &&
    isSameReference(condition.arguments[0], targetNode)
  ) {
    return true
  }

  return false
}

function isNotNullTest (test, targetNode, context) {
  test = unwrapChainExpression(test)

  if (!test) return false

  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    // For `a && b`, the consequent only runs when both are true, so any not-null guard in the chain is sufficient.
    return isNotNullTest(test.left, targetNode, context) || isNotNullTest(test.right, targetNode, context)
  }

  // x, !!x, Boolean(x)
  if (isNullGuard(test, targetNode, context)) return true

  // x != null / x !== null / null != x / null !== x
  if (
    test.type === 'BinaryExpression' &&
    (test.operator === '!==' || test.operator === '!=') &&
    (
      (test.right?.type === 'Literal' && test.right.value === null && isSameReference(test.left, targetNode)) ||
      (test.left?.type === 'Literal' && test.left.value === null && isSameReference(test.right, targetNode))
    )
  ) {
    return true
  }

  return false
}

function isUndefinedNode (node) {
  node = unwrapChainExpression(node)
  if (!node) return false

  if (node.type === 'Identifier' && node.name === 'undefined') return true

  // `void 0` (and variants) are also undefined.
  if (node.type === 'UnaryExpression' && node.operator === 'void') return true

  return false
}

function isNullTest (test, targetNode, context) {
  test = unwrapChainExpression(test)

  if (!test) return false

  // (x === undefined || x === null) and friends
  // If the OR expression is false, it implies x is neither undefined nor null.
  if (test.type === 'LogicalExpression' && test.operator === '||') {
    return isNullTest(test.left, targetNode, context) && isNullTest(test.right, targetNode, context)
  }

  // x == null / x === null / null == x / null === x
  if (
    test.type === 'BinaryExpression' &&
    (test.operator === '===' || test.operator === '==') &&
    (
      (test.right?.type === 'Literal' && test.right.value === null && isSameReference(test.left, targetNode)) ||
      (test.left?.type === 'Literal' && test.left.value === null && isSameReference(test.right, targetNode))
    )
  ) {
    return true
  }

  // x == undefined / x === undefined / undefined == x / undefined === x
  if (
    test.type === 'BinaryExpression' &&
    (test.operator === '===' || test.operator === '==') &&
    (
      (isUndefinedNode(test.right) && isSameReference(test.left, targetNode)) ||
      (isUndefinedNode(test.left) && isSameReference(test.right, targetNode))
    )
  ) {
    return true
  }

  // !(x != null) and !(x !== null) are also "is-null-ish" tests in practice, but we keep it simple for now.
  return false
}

function isFalsyTest (test, targetNode) {
  test = unwrapChainExpression(test)
  if (!test) return false

  // !x / !x.y
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    return isSameReference(test.argument, targetNode)
  }

  return false
}

function isTerminatingStatement (statement) {
  if (!statement) return false

  if (
    statement.type === 'ReturnStatement' ||
    statement.type === 'ThrowStatement' ||
    statement.type === 'BreakStatement' ||
    statement.type === 'ContinueStatement'
  ) {
    return true
  }

  if (statement.type === 'BlockStatement') {
    const last = statement.body.at(-1)
    return isTerminatingStatement(last)
  }

  // Intentionally conservative: don't try to reason about try/finally, switches, etc.
  return false
}

function isDefinitelyNonNullishValue (node) {
  node = unwrapChainExpression(node)
  if (!node) return false

  if (node.type === 'Literal') {
    // Only `null` is nullish for Literal nodes.
    return node.value !== null
  }

  if (isUndefinedNode(node)) return false

  // Objects / arrays / functions / classes / new instances are all non-nullish values.
  if (
    node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassExpression' ||
    node.type === 'NewExpression'
  ) {
    return true
  }

  if (node.type === 'TemplateLiteral') return true

  return false
}

function isNonNullishAssignmentInConsequent (consequent, targetNode) {
  if (!consequent) return false

  let statement = consequent
  if (statement.type === 'BlockStatement') {
    if (statement.body.length !== 1) return false
    statement = statement.body[0]
  }

  if (statement.type !== 'ExpressionStatement') return false

  const expr = unwrapChainExpression(statement.expression)
  if (!expr || expr.type !== 'AssignmentExpression' || expr.operator !== '=') return false

  if (!isSameReference(expr.left, targetNode)) return false

  return isDefinitelyNonNullishValue(expr.right)
}

function isGuardedByIfStatement (node, targetNode, context) {
  let child = node
  let parent = node.parent

  while (parent) {
    if (parent.type === 'IfStatement') {
      if (parent.consequent === child) {
        if (isNotNullTest(parent.test, targetNode, context)) return true
      } else if (parent.alternate === child) {
        // Inside the alternate, we know the test is false.
        // If the test was a null-check, then the alternate implies not-null.
        if (isNullTest(parent.test, targetNode, context)) return true
      }
    }

    child = parent
    parent = parent.parent
  }

  return false
}

function isGuaranteedNotNullByPriorStatements (node, targetNode, context) {
  // Find the closest statement that contains `node`.
  let statement = node
  while (statement && !/Statement$/.test(statement.type)) {
    statement = statement.parent
  }

  if (!statement) return false

  const container = statement.parent
  if (!container || (container.type !== 'BlockStatement' && container.type !== 'Program')) return false

  const body = container.body
  const idx = body.indexOf(statement)
  if (idx <= 0) return false

  for (let i = idx - 1; i >= 0; i--) {
    const prev = body[i]
    if (prev?.type !== 'IfStatement') continue

    // if (x == null) return;  -> after this, x is not-null (and possibly not-undefined)
    // if (!x) return;         -> after this, x is truthy
    const isNullish = isNullTest(prev.test, targetNode, context)
    const isFalsy = isFalsyTest(prev.test, targetNode)
    if (!isNullish && !isFalsy) continue

    // Most reliable: an early return/throw/etc.
    if (isTerminatingStatement(prev.consequent)) return true

    // Also accept nullish "normalization" like:
    // if (x === undefined || x === null) { x = 1 } ... typeof x === 'object'
    if (isNullish && isNonNullishAssignmentInConsequent(prev.consequent, targetNode)) return true
  }

  return false
}
