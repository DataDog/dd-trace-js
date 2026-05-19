import { RuleTester } from 'eslint'
import rule from './eslint-prefer-set-service-name.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-prefer-set-service-name', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Unrelated tags
    "span.setTag('http.status_code', 200)",
    "span.setTag('component', 'http')",
    "span.addTags({ 'http.method': 'GET' })",
    // Computed property in addTags object with non-service key
    "span.addTags({ [keyVar]: 'x' })",
    // Method on something other than setTag/addTags
    "span.set('service.name', 'x')",
    // Template literal containing an expression (can't be statically resolved)
    'span.setTag(`service.${suffix}`, x)',
    // Spread-only object — keys unknown
    'span.addTags({ ...meta })',
  ],
  invalid: [
    {
      code: "span.setTag('service', 'my-svc')",
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: "span.setTag('service.name', 'my-svc')",
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: 'span.setTag(`service.name`, value)',
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: "span.addTags({ 'service.name': 'my-svc' })",
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: 'span.addTags({ service: name })',
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: "span.addTags({ 'http.method': 'GET', 'service.name': 'svc' })",
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: "this._tracer.scope().active().setTag('service.name', name)",
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: 'span.setTag(SERVICE_NAME, name)',
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: 'span.setTag(SERVICE_KEY, name)',
      errors: [{ messageId: 'preferSetServiceName' }],
    },
    {
      code: 'span.addTags({ [SERVICE_NAME]: name })',
      errors: [{ messageId: 'preferSetServiceName' }],
    },
  ],
})
