// Boolean assertions like `assert(value)` and `assert.ok(value)` are usually fine — Node's
// AssertionError prints both the source line and the actual runtime value of the asserted
// expression, so `assert.ok(obj[KEY])` failing reveals which key, what was there, and that it was
// falsy. The failure is only useless when the expression *boolean-reduces*, hiding the operand
// values behind a plain `true`/`false`. For example:
//
//   - `assert.ok(duration >= 1000)` — failure shows `actual: false`, not what `duration` was.
//   - `assert.ok(text.includes('foo'))` — failure shows `actual: false`, not what `text` was.
//
// This rule flags only those boolean-reducing patterns:
//
//   - Value comparisons: `<`, `<=`, `>`, `>=`, `===`, `!==`, `==`, `!=`
//   - Logical combinations: `&&`, `||`, `??`
//   - `in` / `instanceof` (only when an operand isn't a simple reference; with simple operands
//     the source line fully describes the question, e.g. `'foo' in carrier`)
//   - Boolean-returning predicate method calls (see `BOOLEAN_PREDICATE_METHODS` below),
//     e.g. `arr.includes('foo')`, `Array.isArray(x)`, `Object.hasOwn(obj, 'k')`. String-matching
//     predicates (`startsWith` / `endsWith` / `String#match` / `RegExp#test`) are handled by
//     the more specific `eslint-prefer-assert-match` rule and intentionally omitted here.
//   - `new` expressions and other shapes whose value isn't meaningful on its own
//
// Allowed without a message (Node's assertion error is informative on its own):
//
//   - Truthy checks of values, including dynamic indexing: `isReady`, `obj.prop.sub`, `arr[i]`,
//     `map[`key-${id}`]`, `obj?.prop`
//   - Calls that may return data: `getResult()`, `arr.find(cb)`, `predicate(x)`
//   - Getter-style navigation: `span.context()._tags`
//   - Structural unary ops on a simple operand: `!isReady`, `typeof x`, `delete obj.k`
//   - `in` / `instanceof` with simple operands: `'foo' in carrier`, `err instanceof Error`

/** @typedef {import('estree').Node} Node */
/** @typedef {import('estree').CallExpression} CallExpression */

const ASSERT_CALL_NAMES = ['assert', 'assert.ok']

// Unary operators that don't hide a "value of interest": they just transform a reference into a
// boolean/type/undefined. `+`, `-`, `~` are excluded — those hide numeric value differences.
const TRIVIAL_UNARY_OPERATORS = new Set(['!', 'typeof', 'void', 'delete'])

// Binary operators that ask a structural yes/no question with both operands inspectable from
// source. Excludes value comparisons (`===`, `==`, `<`, `>`, etc.) which hide the actual value.
const TRIVIAL_BINARY_OPERATORS = new Set(['in', 'instanceof'])

// Method names that conventionally return a boolean. When the callee of a CallExpression is a
// MemberExpression with one of these as its (non-computed) property name, the call's result is
// effectively a boolean — Node's `actual: false` then hides the real operand value, so we flag it.
//
// String-matching predicates (`startsWith`, `endsWith`, `match`, regex `test`) are intentionally
// NOT in this list: the dedicated `eslint-prefer-assert-match` rule handles those with a more
// specific suggestion (use `assert.match` / `assert.doesNotMatch`) and an autofixer.
const BOOLEAN_PREDICATE_METHODS = new Set([
  // Array containment (String containment is handled separately by `eslint-prefer-assert-match`
  // via regex matching, but `.includes` is ambiguous between String and Array, so we keep it here)
  'includes',
  // Iterable reductions (Array.prototype)
  'some', 'every',
  // Property existence (Object.prototype, Object static)
  'hasOwnProperty', 'hasOwn',
  // Type predicates (Array / Buffer / Number / Object / Reflect statics)
  'isArray', 'isBuffer', 'isNaN', 'isFinite', 'isInteger', 'isSafeInteger',
  'isFrozen', 'isSealed', 'isExtensible',
  // Buffer / structural equality
  'equals',
])

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a message argument on boolean assertions (`assert(value)` / `assert.ok(value)`) ' +
        'whose first argument is a non-trivial expression, so failure messages reveal what was asserted.',
      recommended: true,
    },
    schema: [],
    messages: {
      missingMessage:
        '`{{name}}(...)` with a non-trivial first argument should pass a descriptive message as the ' +
        'second argument. Without it, failures only report "Expected true, got false" without any ' +
        'context about the actual value. Include the runtime value in the message to make failures ' +
        'debuggable.',
    },
  },

  create (context) {
    return {
      CallExpression (node) {
        const calleeName = getMatchedAssertName(node.callee)
        if (calleeName === undefined) return

        if (node.arguments.length === 0) return

        const firstArg = node.arguments[0]

        if (firstArg.type === 'SpreadElement') return

        if (node.arguments.length >= 2) return

        if (isTrivialExpression(firstArg)) return

        context.report({
          node,
          messageId: 'missingMessage',
          data: { name: calleeName },
        })
      },
    }
  },
}

/**
 * @param {Node} callee
 * @returns {string | undefined}
 */
function getMatchedAssertName (callee) {
  for (const name of ASSERT_CALL_NAMES) {
    const parts = name.split('.')

    if (parts.length === 1) {
      if (callee.type === 'Identifier' && callee.name === parts[0]) {
        return name
      }
    } else if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      callee.object.type === 'Identifier' &&
      callee.object.name === parts[0] &&
      callee.property.type === 'Identifier' &&
      callee.property.name === parts[1]
    ) {
      return name
    }
  }

  return undefined
}

/**
 * A "trivial" expression is one whose source text already describes what is being asserted on,
 * so a failure of "Expected true, got false" is informative enough on its own. See the file
 * header for the full taxonomy.
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isTrivialExpression (node) {
  if (node.type === 'ChainExpression') {
    return isTrivialExpression(node.expression)
  }

  if (
    node.type === 'Literal' ||
    node.type === 'Identifier' ||
    node.type === 'ThisExpression' ||
    node.type === 'Super'
  ) {
    return true
  }

  if (node.type === 'MemberExpression') {
    // Both `obj.prop` and `obj[anything]` are trivial — Node's AssertionError will print the
    // actual value at that key. (Dynamic subscripts are accepted: `arr[i]`, `map[`key-${id}`]`.)
    return isTrivialExpression(node.object)
  }

  if (node.type === 'UnaryExpression') {
    return TRIVIAL_UNARY_OPERATORS.has(node.operator) && isTrivialExpression(node.argument)
  }

  if (node.type === 'BinaryExpression') {
    return TRIVIAL_BINARY_OPERATORS.has(node.operator) &&
      isTrivialExpression(node.left) &&
      isTrivialExpression(node.right)
  }

  if (node.type === 'CallExpression') {
    // Calls to known boolean-returning predicate methods (`arr.includes(x)`, `Array.isArray(x)`,
    // `Object.hasOwn(o, k)`, …) reduce to a plain `true`/`false`, so flag them like comparisons.
    if (isBooleanPredicateCall(node.callee)) return false

    // Any other call is trivial: its return value (whatever it is) will appear as `actual` in
    // Node's AssertionError. We deliberately don't recurse into the arguments — they affect what
    // the call returns, but not how informative the failure message is, and being strict about
    // them only produces false positives on innocent calls like `arr.find(x => x.foo === 'bar')`.
    return isTrivialExpression(node.callee)
  }

  return false
}

/**
 * @param {Node} callee
 * @returns {boolean}
 */
function isBooleanPredicateCall (callee) {
  const target = callee.type === 'ChainExpression' ? callee.expression : callee

  return (
    target.type === 'MemberExpression' &&
    !target.computed &&
    target.property.type === 'Identifier' &&
    BOOLEAN_PREDICATE_METHODS.has(target.property.name)
  )
}
