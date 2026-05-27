import { RuleTester } from 'eslint'
import rule from './eslint-no-tags-in-start-span.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-no-tags-in-start-span', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // No options argument
    "tracer.startSpan('my.span')",
    // Options without tags
    "tracer.startSpan('my.span', { childOf, integrationName: 'foo' })",
    // _addTags called after creation (the correct pattern)
    "const span = tracer.startSpan('my.span', { childOf }); span._addTags({ component: 'foo' })",
    // Unrelated method named differently
    "tracer.initSpan('my.span', { tags: { component: 'foo' } })",
    // Second arg is not an object literal (variable)
    "tracer.startSpan('my.span', opts)",
    // Spread-only options — no statically visible tags key
    "tracer.startSpan('my.span', { ...opts })",
  ],
  invalid: [
    {
      code: "tracer.startSpan('my.span', { tags: { component: 'foo' } })",
      errors: [{ messageId: 'noTagsInStartSpan' }],
    },
    {
      code: "this.tracer.startSpan('my.span', { childOf, tags: { 'service.name': svc } })",
      errors: [{ messageId: 'noTagsInStartSpan' }],
    },
    {
      code: "tracer.startSpan('my.span', { integrationName: 'foo', tags: {} })",
      errors: [{ messageId: 'noTagsInStartSpan' }],
    },
    {
      code: 'tracer.startSpan(name, { startTime, childOf, tags: { ...meta } })',
      errors: [{ messageId: 'noTagsInStartSpan' }],
    },
  ],
})
