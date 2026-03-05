import path from 'node:path'

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Suggest using assertObjectContains for 3+ consecutive ' +
        'assert.strictEqual calls on the same object',
      recommended: false,
    },
    fixable: 'code',
    messages: {
      preferObjectContains:
        'Found {{count}} consecutive assert.strictEqual() calls on ' +
        "properties of '{{objectName}}'. Consider using " +
        'assertObjectContains({{objectName}}, { ... }) for better ' +
        'error output.',
    },
    schema: [],
  },

  create (context) {
    let hasAssertObjectContains = false
    let lastRequireNode = null

    return {
      CallExpression (node) {
        // Track requires to know where to insert the import
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal'
        ) {
          const stmt = node.parent?.type === 'VariableDeclarator'
            ? node.parent.parent
            : node.parent
          if (isTopLevelStatement(stmt, context)) {
            lastRequireNode = stmt
          }
        }
      },

      VariableDeclarator (node) {
        // Track if assertObjectContains is already imported
        if (node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (
              prop.type === 'Property' &&
              prop.key.name === 'assertObjectContains'
            ) {
              hasAssertObjectContains = true
            }
          }
        } else if (
          node.id.type === 'Identifier' &&
          node.id.name === 'assertObjectContains'
        ) {
          hasAssertObjectContains = true
        }
      },

      BlockStatement (node) {
        checkBody(node.body, context, () => hasAssertObjectContains,
          (v) => { hasAssertObjectContains = v },
          () => lastRequireNode)
      },
      Program (node) {
        checkBody(node.body, context, () => hasAssertObjectContains,
          (v) => { hasAssertObjectContains = v },
          () => lastRequireNode)
      },
    }
  },
}

function isTopLevelStatement (node, context) {
  if (!node) return false
  const sourceCode = context.sourceCode ?? context.getSourceCode()
  return sourceCode.ast.body.includes(node)
}

function checkBody (
  body, context, getHasImport, setHasImport, getLastRequire
) {
  const sourceCode = context.sourceCode ?? context.getSourceCode()

  let i = 0
  while (i < body.length) {
    const groups = findConsecutiveStrictEqualCalls(body, i)
    if (groups.length >= 3) {
      const firstStatement = body[i]
      const rootObject = getRootObjectFromCall(firstStatement)
      if (rootObject && allPathsResolvable(groups, rootObject, sourceCode)) {
        context.report({
          node: firstStatement,
          messageId: 'preferObjectContains',
          data: {
            count: groups.length,
            objectName: rootObject,
          },
          fix (fixer) {
            return buildFix(
              fixer, sourceCode, groups, rootObject,
              getHasImport, setHasImport, getLastRequire, context,
            )
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

function allPathsResolvable (groups, rootName, sourceCode) {
  for (const stmt of groups) {
    const firstArg = stmt.expression.arguments[0]
    if (!getPropertyPath(firstArg, rootName, sourceCode)) return false
  }
  return true
}

/**
 * Extract property path segments from a MemberExpression, stripping
 * the root identifier. Returns null if any segment uses a non-literal
 * computed property (template strings, variables).
 *
 * Example: `span.meta['key']` with root `span`
 *   → [{ key: 'meta', computed: false }, { key: "'key'", computed: true }]
 */
function getPropertyPath (memberExpr, rootName, sourceCode) {
  const segments = []
  let current = memberExpr

  while (current.type === 'MemberExpression') {
    if (current.computed) {
      // Only allow string/number literals as computed keys
      if (current.property.type !== 'Literal') return null
      segments.unshift({
        key: sourceCode.getText(current.property),
        computed: true,
      })
    } else {
      segments.unshift({
        key: current.property.name,
        computed: false,
      })
    }
    current = current.object
  }

  // current should now be the root identifier
  if (current.type !== 'Identifier' || current.name !== rootName) {
    return null
  }

  return segments
}

/**
 * Build a nested object string from an array of entries.
 * Each entry has { path: [{key, computed}], valueText }.
 */
function buildObjectLiteral (entries, indent) {
  // Group entries by their first path segment
  const groups = new Map()

  for (const entry of entries) {
    if (entry.path.length === 1) {
      // Leaf: key → value
      const seg = entry.path[0]
      const key = seg.computed ? `[${seg.key}]` : seg.key
      if (!groups.has(key)) {
        groups.set(key, { leaf: true, seg, valueText: entry.valueText })
      }
    } else {
      // Nested: group by first segment, recurse with rest
      const seg = entry.path[0]
      const key = seg.computed ? `[${seg.key}]` : seg.key
      if (!groups.has(key)) {
        groups.set(key, { leaf: false, seg, children: [] })
      }
      const group = groups.get(key)
      if (group.leaf) continue // conflict: skip
      group.children.push({
        path: entry.path.slice(1),
        valueText: entry.valueText,
      })
    }
  }

  const inner = indent + '  '
  const parts = []

  for (const [, group] of groups) {
    if (group.leaf) {
      const propKey = group.seg.computed ? `[${group.seg.key}]` : group.seg.key
      parts.push(`${inner}${propKey}: ${group.valueText}`)
    } else {
      const nestedObj = buildObjectLiteral(group.children, inner)
      const propKey = group.seg.computed ? `[${group.seg.key}]` : group.seg.key
      parts.push(`${inner}${propKey}: ${nestedObj}`)
    }
  }

  return `{\n${parts.join(',\n')},\n${indent}}`
}

/**
 * Build the fix: replace the group of strictEqual calls with a
 * single assertObjectContains call, and insert the import if needed.
 */
function buildFix (
  fixer, sourceCode, groups, rootName,
  getHasImport, setHasImport, getLastRequire, context
) {
  // Extract entries from each strictEqual call
  const entries = []
  for (const stmt of groups) {
    const expr = stmt.expression
    const firstArg = expr.arguments[0]
    const secondArg = expr.arguments[1]

    const path = getPropertyPath(firstArg, rootName, sourceCode)
    if (!path || path.length === 0) return null

    const valueText = sourceCode.getText(secondArg)
    entries.push({ path, valueText })
  }

  // Detect the indentation of the first statement
  const firstLine = sourceCode.lines[groups[0].loc.start.line - 1]
  const indent = firstLine.match(/^(\s*)/)[1]

  const objLiteral = buildObjectLiteral(entries, indent)
  const replacement =
    `assertObjectContains(${rootName}, ${objLiteral})`

  const fixes = []

  // Replace from start of first statement to end of last statement
  const rangeStart = groups[0].range[0]
  const rangeEnd = groups[groups.length - 1].range[1]
  fixes.push(fixer.replaceTextRange([rangeStart, rangeEnd], replacement))

  // Add import if needed
  if (!getHasImport()) {
    const requirePath = computeRequirePath(context)
    if (requirePath) {
      const requireStmt =
        `const { assertObjectContains } = require('${requirePath}')\n`
      const lastReq = getLastRequire()
      if (lastReq) {
        fixes.push(
          fixer.insertTextAfter(lastReq, '\n' + requireStmt),
        )
      }
      setHasImport(true)
    }
  }

  return fixes
}

/**
 * Compute the relative require path from the current file to the
 * integration-tests/helpers module.
 */
function computeRequirePath (context) {
  const filename = context.filename ?? context.getFilename()
  if (!filename || filename === '<input>') return null

  let root
  const packagesIdx = filename.lastIndexOf('/packages/')
  if (packagesIdx !== -1) {
    root = filename.slice(0, packagesIdx)
  } else {
    root = context.cwd ?? context.getCwd()
  }

  const fromDir = path.dirname(filename)
  const helpersAbsolute = path.join(root, 'integration-tests', 'helpers')
  let relative = path.relative(fromDir, helpersAbsolute)

  if (!relative.startsWith('.')) {
    relative = './' + relative
  }
  return relative
}
