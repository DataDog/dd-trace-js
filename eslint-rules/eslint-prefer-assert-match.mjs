// Flag `assert.ok(...)` calls whose first argument is a plain string-matching
// expression and recommend `assert.match()` / `assert.doesNotMatch()` instead.
//
// `assert.match()` gives much nicer failure messages than `assert.ok()`:
// it prints both the actual string and the regex, while `assert.ok(false)`
// just prints `false`.
//
// Patterns recognized as the first argument to `assert.ok(...)`:
//
//   x.startsWith(y)   -> assert.match(x, /^y/)
//   x.endsWith(y)     -> assert.match(x, /y$/)
//   x.match(/r/)      -> assert.match(x, /r/)
//   /r/.test(x)       -> assert.match(x, /r/)
//
// A leading `!` negates the assertion, producing `assert.doesNotMatch(...)`.
//
// `x.includes(...)` is intentionally NOT handled because it is ambiguous at
// lint time between String.prototype.includes (a string match) and
// Array.prototype.includes (membership in a collection).

// Regex metacharacters that need escaping when embedding a string value as a
// regex pattern. We also escape `/` so the result is safe to wrap in `/.../`.
const REGEX_META = /[.*+?^${}()|[\]\\/]/g

// Characters that can't appear literally inside a regex literal (line
// terminators break out of the literal). If a string contains any of these,
// we report but don't auto-fix.
const UNSAFE_IN_REGEX_LITERAL = /[\n\r\u2028\u2029]/

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer `assert.match()` / `assert.doesNotMatch()` over `assert.ok()` for string-matching assertions',
      recommended: true,
    },
    fixable: 'code',
    schema: [],
    messages: {
      preferMatch:
        'Prefer `assert.match(string, regexp)` over `assert.ok({{method}}(...))` for string-matching assertions.',
      preferDoesNotMatch:
        'Prefer `assert.doesNotMatch(string, regexp)` over `assert.ok(!{{method}}(...))` ' +
        'for string-matching assertions.',
    },
  },

  create (context) {
    const sourceCode = context.getSourceCode()

    return {
      CallExpression (node) {
        if (!isAssertOkCall(node)) return
        if (node.arguments.length < 1 || node.arguments.length > 2) return

        const [firstArg, messageArg] = node.arguments
        if (!firstArg || firstArg.type === 'SpreadElement') return
        if (messageArg && messageArg.type === 'SpreadElement') return

        let inner = unwrapChain(firstArg)
        let negated = false
        if (inner.type === 'UnaryExpression' && inner.operator === '!') {
          negated = true
          inner = unwrapChain(inner.argument)
        }

        const match = matchStringMethod(inner)
        if (!match) return

        const { stringNode, regexText, autofixable } = buildReplacementParts(match, sourceCode)
        if (!stringNode) return

        const assertMethod = negated ? 'doesNotMatch' : 'match'
        const messageId = negated ? 'preferDoesNotMatch' : 'preferMatch'

        context.report({
          node,
          messageId,
          data: { method: match.methodName },
          fix: autofixable && regexText
            ? fixer => {
              const stringText = sourceCode.getText(stringNode)
              const messageText = messageArg ? `, ${sourceCode.getText(messageArg)}` : ''
              return fixer.replaceText(node, `assert.${assertMethod}(${stringText}, ${regexText}${messageText})`)
            }
            : null,
        })
      },
    }
  },
}

/**
 * @param {import('estree').Node} node
 * @returns {import('estree').Node}
 */
function unwrapChain (node) {
  return node?.type === 'ChainExpression' ? node.expression : node
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isAssertOkCall (node) {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'assert' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'ok'
  )
}

/**
 * Returns the kind of string-matching call this expression is, or null if it
 * isn't one of the patterns we care about.
 *
 * @param {import('estree').Node} node
 * @returns {{ methodName: string, callee: import('estree').MemberExpression, arg: import('estree').Node } | null}
 */
function matchStringMethod (node) {
  if (!node || node.type !== 'CallExpression') return null
  if (node.arguments.length !== 1) return null
  const arg = node.arguments[0]
  if (!arg || arg.type === 'SpreadElement') return null

  const callee = node.callee
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null
  if (callee.property?.type !== 'Identifier') return null

  const methodName = callee.property.name
  if (methodName !== 'startsWith' &&
      methodName !== 'endsWith' &&
      methodName !== 'match' &&
      methodName !== 'test') {
    return null
  }

  return { methodName, callee, arg }
}

/**
 * @param {{ methodName: string, callee: import('estree').MemberExpression, arg: import('estree').Node }} match
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {{ stringNode: import('estree').Node | null, regexText: string | null, autofixable: boolean }}
 */
function buildReplacementParts (match, sourceCode) {
  const { methodName, callee, arg } = match

  switch (methodName) {
    case 'startsWith':
    case 'endsWith': {
      const stringNode = callee.object
      if (isStringLiteral(arg)) {
        const pattern = stringLiteralToRegexBody(arg.value)
        if (pattern !== null) {
          const regexText = methodName === 'startsWith' ? `/^${pattern}/` : `/${pattern}$/`
          return { stringNode, regexText, autofixable: true }
        }
      }
      return { stringNode, regexText: null, autofixable: false }
    }

    case 'match': {
      const stringNode = callee.object
      if (isRegexLiteral(arg)) {
        return { stringNode, regexText: sourceCode.getText(arg), autofixable: true }
      }
      return { stringNode, regexText: null, autofixable: false }
    }

    case 'test': {
      const stringNode = arg
      const regexNode = callee.object
      return { stringNode, regexText: sourceCode.getText(regexNode), autofixable: true }
    }

    default:
      return { stringNode: null, regexText: null, autofixable: false }
  }
}

/**
 * @param {import('estree').Node} node
 * @returns {node is import('estree').Literal & { value: string }}
 */
function isStringLiteral (node) {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isRegexLiteral (node) {
  return node?.type === 'Literal' && node.regex != null
}

/**
 * Convert a JS string value into a body that's safe to embed between `/.../`.
 * Returns null when the value contains characters that can't appear literally
 * in a regex literal (e.g. raw newlines).
 *
 * @param {string} value
 * @returns {string | null}
 */
function stringLiteralToRegexBody (value) {
  if (UNSAFE_IN_REGEX_LITERAL.test(value)) return null
  return value.replace(REGEX_META, '\\$&')
}
