import { RuleTester } from 'eslint'
import rule from './eslint-timer-unref.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
})

ruleTester.run('eslint-timer-unref', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Already uses optional chaining on the call
    'timer.unref?.()',
    'timer?.unref?.()',
    // Computed property — not matched
    "timer['unref']()",
    // Unrelated method calls
    'timer.ref()',
    'clearTimeout(timer)',
    'obj.unref.call(timer)',
  ],
  invalid: [
    {
      code: 'timer.unref()',
      output: 'timer.unref?.()',
      errors: 1,
    },
    {
      code: 'const t = setTimeout(fn, 100); t.unref()',
      output: 'const t = setTimeout(fn, 100); t.unref?.()',
      errors: 1,
    },
    // Optional member access but non-optional call — still needs ?.()
    {
      code: 'timer?.unref()',
      output: 'timer?.unref?.()',
      errors: 1,
    },
  ],
})
