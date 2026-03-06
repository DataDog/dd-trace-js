/**
 * ESLint rule: prefer-optional-chaining
 *
 * Detects guard-then-access patterns that can be simplified with optional chaining:
 *
 * Pattern 1 (&&): `x && x.y` → `x?.y`
 *   Also handles chains: `x && x.y && x.y.z` → `x?.y?.z`
 *   Also handles: `a && b && b.c` → `a && b?.c` (prefix preserved)
 *
 * Pattern 2 (||): `!x || !x.y` → `!x?.y`
 *   De Morgan's dual of pattern 1.
 *
 * Note: `x && x.y` guards against any falsy value, while `x?.y` only guards
 * against null/undefined. In this codebase, guarded objects are consistently
 * either an object or null/undefined (never 0, "", or false), so the
 * transformation is safe. Use `eslint-disable` for the rare exceptions.
 */
export default {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: {
      description:
        'Prefer optional chaining (?.) over guard-then-access patterns ' +
        '(e.g., `x && x.y` → `x?.y`).',
    },
    messages: {
      preferOptionalChaining:
        'Use optional chaining instead of `{{ original }}`. ' +
        'Prefer `{{ replacement }}`.',
    },
    schema: [],
  },
  create (context) {
    const sourceCode = context.getSourceCode()
    const reported = new WeakSet()

    return {
      LogicalExpression (node) {
        // Avoid duplicate reports when parent is already reported
        if (reported.has(node)) return

        const result = tryAndChain(node, sourceCode) ?? tryOrChain(node, sourceCode)
        if (!result) return

        reported.add(node)
        markInner(node, reported)

        context.report({
          node,
          messageId: 'preferOptionalChaining',
          data: {
            original: truncate(sourceCode.getText(node), 60),
            replacement: result.replacement,
          },
          fix (fixer) {
            return fixer.replaceText(node, result.replacement)
          },
        })
      },
    }
  },
}

/**
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate (str, max) {
  const oneline = str.replace(/\s+/g, ' ')
  return oneline.length > max ? oneline.slice(0, max - 3) + '...' : oneline
}

/**
 * Mark all nested LogicalExpression nodes as reported to prevent duplicates.
 * @param {import('estree').Node} node
 * @param {WeakSet} reported
 */
function markInner (node, reported) {
  if (node.left?.type === 'LogicalExpression') {
    reported.add(node.left)
    markInner(node.left, reported)
  }
  if (node.right?.type === 'LogicalExpression') {
    reported.add(node.right)
    markInner(node.right, reported)
  }
}

// ---------------------------------------------------------------------------
// Pattern 1: x && x.y  /  x && x.y && x.y.z
// ---------------------------------------------------------------------------

/**
 * @param {import('estree').LogicalExpression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {{ replacement: string } | null}
 */
function tryAndChain (node, sourceCode) {
  if (node.operator !== '&&') return null

  const parts = flattenLogical(node, '&&')
  return buildChainResult(parts, '&&', sourceCode, false)
}

// ---------------------------------------------------------------------------
// Pattern 2: !x || !x.y  (De Morgan dual)
// ---------------------------------------------------------------------------

/**
 * @param {import('estree').LogicalExpression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {{ replacement: string } | null}
 */
function tryOrChain (node, sourceCode) {
  if (node.operator !== '||') return null

  const parts = flattenLogical(node, '||')

  // Every part must be a UnaryExpression(!)
  if (!parts.every(p => p.type === 'UnaryExpression' && p.operator === '!')) return null

  const innerParts = parts.map(p => p.argument)
  return buildChainResult(innerParts, '||', sourceCode, true)
}

// ---------------------------------------------------------------------------
// Shared core
// ---------------------------------------------------------------------------

/**
 * @param {import('estree').Expression[]} parts
 * @param {string} operator - '&&' or '||'
 * @param {import('eslint').SourceCode} sourceCode
 * @param {boolean} negated - true for the !x || !x.y pattern
 * @returns {{ replacement: string } | null}
 */
function buildChainResult (parts, operator, sourceCode, negated) {
  if (parts.length < 2) return null

  // Find the longest suffix of consecutive guarded accesses
  // Walk backwards from the end
  let chainStart = parts.length - 1

  for (let i = parts.length - 2; i >= 0; i--) {
    if (!isGuardedAccess(parts[i], parts[i + 1], sourceCode)) break
    chainStart = i
  }

  const chainEnd = parts.length - 1
  if (chainStart === chainEnd) return null

  // Build the optional chain expression from the chain parts
  const chainParts = parts.slice(chainStart, chainEnd + 1)
  const optionalExpr = buildOptionalChainFromParts(chainParts, sourceCode)
  if (!optionalExpr) return null

  // Build the prefix (non-chained parts)
  const prefixParts = parts.slice(0, chainStart)

  if (negated) {
    if (prefixParts.length > 0) {
      const prefixText = prefixParts.map(p => `!${sourceCode.getText(p)}`).join(` ${operator} `)
      return { replacement: `${prefixText} ${operator} !${optionalExpr}` }
    }
    return { replacement: `!${optionalExpr}` }
  }

  if (prefixParts.length > 0) {
    const prefixText = prefixParts.map(p => sourceCode.getText(p)).join(` ${operator} `)
    return { replacement: `${prefixText} ${operator} ${optionalExpr}` }
  }

  return { replacement: optionalExpr }
}

/**
 * Flatten a left-associative chain of the same operator into an array.
 *
 * @param {import('estree').LogicalExpression} node
 * @param {string} operator
 * @returns {import('estree').Expression[]}
 */
function flattenLogical (node, operator) {
  const parts = []
  let current = node
  while (current.type === 'LogicalExpression' && current.operator === operator) {
    parts.push(current.right)
    current = current.left
  }
  parts.push(current)
  parts.reverse()
  return parts
}

/**
 * Check if `access` is a member/call expression that extends `guard`.
 *
 * Uses source text comparison: `access` text must start with `guard` text
 * followed by `.`, `[`, or `(`.
 *
 * @param {import('estree').Expression} guard
 * @param {import('estree').Expression} access
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isGuardedAccess (guard, access, sourceCode) {
  // access must be MemberExpression or CallExpression
  if (access.type !== 'MemberExpression' && access.type !== 'CallExpression') return false

  // Skip if the access already uses optional chaining at the boundary
  if (access.type === 'MemberExpression' && access.optional) return false
  if (access.type === 'CallExpression' && access.optional) return false

  const guardText = sourceCode.getText(guard)
  const accessText = sourceCode.getText(access)

  if (!accessText.startsWith(guardText)) return false

  const nextChar = accessText[guardText.length]
  return nextChar === '.' || nextChar === '[' || nextChar === '('
}

/**
 * Build an optional chain expression from a sequence of guarded parts.
 *
 * [x, x.y, x.y.z] → "x?.y?.z"
 * [x, x.y]         → "x?.y"
 * [x.a, x.a.b]     → "x.a?.b"
 *
 * @param {import('estree').Expression[]} chainParts - Sorted guard→final
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {string | null}
 */
function buildOptionalChainFromParts (chainParts, sourceCode) {
  // Start with the final (most specific) expression text
  const finalText = sourceCode.getText(chainParts[chainParts.length - 1])

  // Collect the boundary positions where we need to insert `?`
  // Each guard's text length tells us where the next access begins
  const insertPositions = []

  for (let i = 0; i < chainParts.length - 1; i++) {
    const guardLen = sourceCode.getText(chainParts[i]).length
    insertPositions.push(guardLen)
  }

  // Sort positions in reverse order so we can insert without shifting indices
  insertPositions.sort((a, b) => b - a)

  let result = finalText
  for (const pos of insertPositions) {
    const charAtPos = result[pos]
    if (charAtPos === '.') {
      // Replace `.` with `?.`
      result = result.slice(0, pos) + '?' + result.slice(pos)
    } else if (charAtPos === '[' || charAtPos === '(') {
      // Insert `?.` before `[` or `(`
      result = result.slice(0, pos) + '?.' + result.slice(pos)
    } else {
      return null
    }
  }

  return result
}
