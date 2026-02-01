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
          const targetExpression = context.getSourceCode().getText(targetNode)

          const hasNullCheck = isGuardedInLogicalExpression(node, targetNode) ||
            isGuardedInConditionalExpression(node, targetNode) ||
            isGuardedByIfStatement(node, targetNode) ||
            isGuaranteedNotNullByPriorStatements(node, targetNode, context)

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

function isGuardedInLogicalExpression (node, targetNode) {
  // Find the nearest `&&` chain that contains `node` (this naturally handles cases where the `&&`
  // is nested inside a larger `||` expression).
  let current = node.parent
  while (current) {
    if (current.type === 'LogicalExpression' && current.operator === '&&') {
      const conditions = collectAndConditions(current)
      return conditions.some(condition => condition !== node && isNullGuard(condition, targetNode))
    }
    current = current.parent
  }

  return false
}

function isGuardedInConditionalExpression (node, targetNode) {
  const parent = node.parent
  if (parent?.type !== 'ConditionalExpression') return false

  // - x != null ? typeof x === 'object' : false
  // - x == null ? false : typeof x === 'object'
  if (parent.consequent === node) return isNotNullTest(parent.test, targetNode)
  if (parent.alternate === node) return isNullTest(parent.test, targetNode)

  return false
}

// Helper function to check if an expression acts as a "not-null guard" for the target reference.
function isNullGuard (condition, targetNode) {
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

function isNotNullTest (test, targetNode) {
  test = unwrapChainExpression(test)

  if (!test) return false

  if (test.type === 'LogicalExpression' && test.operator === '&&') {
    // For `a && b`, the consequent only runs when both are true, so any not-null guard in the chain is sufficient.
    return isNotNullTest(test.left, targetNode) || isNotNullTest(test.right, targetNode)
  }

  // Covers: x, !!x, Boolean(x), and x != null / x !== null (and member-expression variants).
  return isNullGuard(test, targetNode)
}

function isUndefinedNode (node) {
  node = unwrapChainExpression(node)
  if (!node) return false

  if (node.type === 'Identifier' && node.name === 'undefined') return true

  // `void 0` (and variants) are also undefined.
  if (node.type === 'UnaryExpression' && node.operator === 'void') return true

  return false
}

function isTargetEqualityCheck (test, targetNode, otherSideCheck) {
  test = unwrapChainExpression(test)

  if (
    !test ||
    test.type !== 'BinaryExpression' ||
    (test.operator !== '===' && test.operator !== '==')
  ) {
    return false
  }

  return (
    (isSameReference(test.left, targetNode) && otherSideCheck(test.right)) ||
    (isSameReference(test.right, targetNode) && otherSideCheck(test.left))
  )
}

function isNullTest (test, targetNode) {
  test = unwrapChainExpression(test)

  if (!test) return false

  // (x === undefined || x === null) and friends
  // If the OR expression is false, it implies x is neither undefined nor null.
  if (test.type === 'LogicalExpression' && test.operator === '||') {
    return isNullTest(test.left, targetNode) && isNullTest(test.right, targetNode)
  }

  // x == null / x === null / null == x / null === x
  if (isTargetEqualityCheck(test, targetNode, node => node?.type === 'Literal' && node.value === null)) {
    return true
  }

  // x == undefined / x === undefined / undefined == x / undefined === x
  if (isTargetEqualityCheck(test, targetNode, isUndefinedNode)) {
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

function getEnclosingBodyInfo (node) {
  // Find the closest statement containing `node`.
  let statement = node
  while (statement && !/Statement$/.test(statement.type)) {
    statement = statement.parent
  }

  if (!statement) return null

  // Lift to the statement that is directly contained in a BlockStatement/Program `body` array.
  // Example: for `else if (...)`, the inner IfStatement is nested under `alternate`, so we lift
  // to the outer IfStatement that actually sits in the block.
  while (statement?.parent && statement.parent.type !== 'BlockStatement' && statement.parent.type !== 'Program') {
    statement = statement.parent
  }

  const container = statement.parent
  if (!container || (container.type !== 'BlockStatement' && container.type !== 'Program')) return null

  const body = container.body
  const idx = body.indexOf(statement)
  if (idx === -1) return null

  return { body, container, idx, statement }
}

function isGuardedByIfStatement (node, targetNode) {
  let child = node
  let parent = node.parent

  while (parent) {
    if (parent.type === 'IfStatement') {
      if (parent.consequent === child) {
        if (isNotNullTest(parent.test, targetNode)) return true
      } else if (parent.alternate === child) {
        // Inside the alternate, we know the test is false.
        // If the test was a null-check, then the alternate implies not-null.
        if (isNullTest(parent.test, targetNode)) return true
      }
    }

    child = parent
    parent = parent.parent
  }

  return false
}

function walkAst (context, node, visitor) {
  const visitorKeys = context.getSourceCode().visitorKeys

  /** @type {unknown[]} */
  const stack = [node]

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    const unwrapped = unwrapChainExpression(current)
    if (!unwrapped || typeof unwrapped !== 'object') continue

    if (visitor(unwrapped)) return true

    const keys = visitorKeys[unwrapped.type]
    if (!keys) continue

    for (const key of keys) {
      const value = unwrapped[key]
      if (!value) continue

      if (Array.isArray(value)) {
        for (const item of value) stack.push(item)
      } else {
        stack.push(value)
      }
    }
  }

  return false
}

function statementWritesToTarget (statement, targetNode, context) {
  return walkAst(context, statement, node => {
    if (node.type === 'AssignmentExpression') {
      return isSameReference(node.left, targetNode)
    }

    if (node.type === 'UpdateExpression') {
      return isSameReference(node.argument, targetNode)
    }

    return false
  })
}

function getRootIdentifierName (reference) {
  reference = unwrapChainExpression(reference)

  let current = reference
  while (current?.type === 'MemberExpression') {
    current = current.object
  }

  return current?.type === 'Identifier' ? current.name : undefined
}

function statementMentionsIdentifierName (statement, name, context) {
  return walkAst(context, statement, node => node.type === 'Identifier' && node.name === name)
}

function hasDominatingGuardBeforeIndex (body, idx, targetNode, context) {
  const rootIdentifierName = getRootIdentifierName(targetNode)

  for (let i = idx - 1; i >= 0; i--) {
    const prev = body[i]

    // First: if this statement is itself a dominating guard, accept it even if it writes
    // to the target (e.g., normalization `if (x == null) { x = 1 }`).
    if (prev?.type === 'IfStatement') {
      // if (x == null) return;  -> after this, x is not-null (and possibly not-undefined)
      // if (!x) return;         -> after this, x is truthy
      const isNullish = isNullTest(prev.test, targetNode)
      const isFalsy = isFalsyTest(prev.test, targetNode)

      if (isNullish || isFalsy) {
        // Most reliable: an early return/throw/etc.
        if (isTerminatingStatement(prev.consequent)) return true

        // Also accept nullish "normalization" like:
        // if (x === undefined || x === null) { x = 1 } ... typeof x === 'object'
        if (isNullish && isNonNullishAssignmentInConsequent(prev.consequent, targetNode)) return true
      }
    }

    // Otherwise: if the target gets written to between the guard and the typeof check, we
    // can't safely assume earlier checks still apply.
    // Short-circuit: if this statement doesn't even mention the root identifier, it can't write to it.
    if (rootIdentifierName && !statementMentionsIdentifierName(prev, rootIdentifierName, context)) continue

    if (statementWritesToTarget(prev, targetNode, context)) break
  }

  return false
}

function isGuaranteedNotNullByPriorStatements (node, targetNode, context) {
  // Walk outward across nested blocks (e.g., try blocks) and look for dominating guards
  // like `if (x === null) return;` that appear before the enclosing statement.
  let info = getEnclosingBodyInfo(node)

  while (info) {
    const { body, container, idx } = info

    if (idx > 0 && hasDominatingGuardBeforeIndex(body, idx, targetNode, context)) {
      return true
    }

    // Move up one nesting level: treat the enclosing statement (e.g., TryStatement)
    // as the current "statement" inside its parent block.
    let next = container.parent
    while (next && !/Statement$/.test(next.type)) next = next.parent
    info = next ? getEnclosingBodyInfo(next) : null
  }

  return false
}
