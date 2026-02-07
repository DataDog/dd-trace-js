import { RuleTester } from 'eslint'
import rule from './eslint-safe-typeof-object.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
})

ruleTester.run('no-typeof-object', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    "x !== null && typeof x === 'object'",
    "typeof x === 'object' && x !== null",

    "x.y !== null && typeof x.y === 'object'",

    "true && x !== null && typeof x === 'object'",
    "someCondition && x !== null && typeof x === 'object'",
    "someCheck() && x !== null && typeof x === 'object'",
    "a && b && x !== null && typeof x === 'object'",

    "x && typeof x === 'object'",
    "!!x && typeof x === 'object'",
    "Boolean(x) && typeof x === 'object'",
    "x != null && typeof x === 'object'",
    "null !== x && typeof x === 'object'",
    "x.y && typeof x.y === 'object'",
    "x?.y != null && typeof x?.y === 'object'",
    "x?.y && typeof x?.y === 'object'",
    "x?.y?.z != null && typeof x.y.z === 'object'",
    "typeof x?.y?.z === 'object' && x.y.z !== null",

    "x !== null && (typeof x === 'object' || typeof x === 'function')",
    "someCondition && x && (typeof x === 'object' || typeof x === 'function')",
    "(x !== null) && (typeof x === 'object' || typeof x === 'function')",
    "!!x && (typeof x === 'object' || typeof x === 'function')",
    "x != null ? typeof x === 'object' : false",
    "x == null ? false : typeof x === 'object'",

    "(x !== null && typeof x === 'object') || typeof x === 'number'",

    "typeof x !== 'object'",

    // Control-flow guards in a function body (return/throw)
    `
      function f (x) {
        if (x === null) return
        if (typeof x === 'object') return x
      }
    `,
    `
      function f (x) {
        if (x == null) { throw new Error('bad') }
        if (typeof x === 'object') return x
      }
    `,
    // Branch guard via if/else
    `
      function f (x) {
        if (x == null) {
          return null
        } else if (typeof x === 'object') {
          return x
        }
      }
    `,
    // Nullish guard via `||` (matches appsec/index.js style)
    `
      function f (body) {
        if (body === undefined || body === null) return
        if (typeof body === 'object') return body
      }
    `,
    // Not-null guard via `&&` around an if block containing typeof
    `
      function f (x) {
        if (x !== undefined && x !== null) {
          if (typeof x === 'object') return x
        }
      }
    `,
    // Non-terminating nullish guard that normalizes the value (should be considered safe)
    `
      function f (x) {
        if (x === undefined || x === null) {
          x = 1
        }
        if (typeof x === 'object') return x
      }
    `,
    // Guard in an outer block should apply inside nested blocks (e.g., try)
    `
      function f (value) {
        if (value === null) return
        try {
          if (typeof value === 'object') return value
        } catch (e) {}
      }
    `,
    // Guard via `continue` in an outer loop should apply inside nested blocks (matches operations-taint-object.js)
    `
      function f (object) {
        const queue = [{ value: object }]
        const visited = new WeakSet()

        while (queue.length > 0) {
          const { value } = queue.pop()
          if (value === null) continue

          try {
            if (typeof value === 'string') {
              // noop
            } else if (typeof value === 'object' && !visited.has(value)) {
              visited.add(value)
            }
          } catch (e) {}
        }
      }
    `,
  ],
  invalid: [
    {
      code: "typeof x === 'object'",
      output: "x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "typeof x.y === 'object'",
      output: "x.y !== null && typeof x.y === 'object'",
      errors: 1,
    },
    {
      code: "!x && typeof x === 'object'",
      output: "!x && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "true && typeof x === 'object'",
      output: "true && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "someCondition && someOtherCondition && typeof x === 'object'",
      output: "someCondition && someOtherCondition && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "a && b && c && typeof x === 'object'",
      output: "a && b && c && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "(typeof x === 'object' || typeof x === 'function')",
      output: "(x !== null && typeof x === 'object' || typeof x === 'function')",
      errors: 1,
    },
    {
      code: "x && typeof x?.y === 'object'",
      output: "x && x?.y !== null && typeof x?.y === 'object'",
      errors: 1,
    },
    // Non-terminating nullish guard that does not return/throw nor normalize the value is unsafe.
    {
      code: `
        function f (x) {
          if (x === undefined || x === null) {
            doSomething(x)
          }
          if (typeof x === 'object') return x
        }
      `,
      output: `
        function f (x) {
          if (x === undefined || x === null) {
            doSomething(x)
          }
          if (x !== null && typeof x === 'object') return x
        }
      `,
      errors: 1,
    },
    // Guarding only `undefined` does not protect against `null`.
    {
      code: `
        function f (x) {
          if (x !== undefined && x !== 1) {
            if (typeof x === 'object') return x
          }
        }
      `,
      output: `
        function f (x) {
          if (x !== undefined && x !== 1) {
            if (x !== null && typeof x === 'object') return x
          }
        }
      `,
      errors: 1,
    },
  ],
})
