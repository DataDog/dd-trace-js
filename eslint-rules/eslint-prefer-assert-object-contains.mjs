export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Suggest using assertObjectContains for 3+ consecutive assert.strictEqual calls on the same object',
      recommended: false,
    },
    messages: {
      preferObjectContains:
        'Found {{count}} consecutive assert.strictEqual() calls on properties of ' +
        '\'{{objectName}}\'. Consider using assertObjectContains({{objectName}}, { ... }) ' +
        'for better error output.',
    },
    schema: [],
  },

  create (context) {
    return {
      BlockStatement (node) {
        checkBody(node.body, context)
      },
      Program (node) {
        checkBody(node.body, context)
      },
    }
  },
}

function checkBody (body, context) {
  let i = 0
  while (i < body.length) {
    const groups = findConsecutiveStrictEqualCalls(body, i)
    if (groups.length >= 3) {
      const firstStatement = body[i]
      const rootObject = getRootObjectFromCall(firstStatement)
      if (rootObject) {
        context.report({
          node: firstStatement,
          messageId: 'preferObjectContains',
          data: {
            count: groups.length,
            objectName: rootObject,
          },
        })
      }
      i += groups.length
    } else {
      i++
    }
  }
}

function findConsecutiveStrictEqualCalls (body, startIdx) {
  const calls = []
  let rootId = null

  for (let i = startIdx; i < body.length; i++) {
    const stmt = body[i]
    if (stmt.type !== 'ExpressionStatement') break

    const expr = stmt.expression
    if (expr.type !== 'CallExpression') break

    const calleeInfo = getCalleeInfo(expr.callee)
    if (!calleeInfo || calleeInfo.name !== 'strictEqual') break

    const firstArg = expr.arguments?.[0]
    if (!firstArg || firstArg.type !== 'MemberExpression') break

    const currentRootId = getRootIdentifier(firstArg)
    if (!currentRootId) break

    if (rootId === null) {
      rootId = currentRootId
    } else if (rootId !== currentRootId) {
      break
    }

    calls.push(stmt)
  }

  return calls
}

function getCalleeInfo (callee) {
  if (callee.type === 'MemberExpression' &&
      callee.object?.type === 'Identifier' &&
      callee.property?.type === 'Identifier') {
    return {
      name: callee.property.name,
      object: callee.object.name,
    }
  }
  return null
}

function getRootIdentifier (memberExpr) {
  let current = memberExpr
  while (current?.type === 'MemberExpression') {
    current = current.object
  }
  return current?.type === 'Identifier' ? current.name : null
}

function getRootObjectFromCall (statement) {
  if (statement?.type !== 'ExpressionStatement') return null
  const expr = statement.expression
  if (expr?.type !== 'CallExpression') return null

  const firstArg = expr.arguments?.[0]
  if (firstArg?.type === 'MemberExpression') {
    return getRootIdentifier(firstArg)
  }
  return null
}
