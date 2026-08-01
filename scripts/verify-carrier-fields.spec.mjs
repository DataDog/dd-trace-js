import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { createCarrierFieldsEslint } from './verify-carrier-fields.mjs'

describe('verify-carrier-fields', () => {
  it('does not allow inline comments to suppress managed-header access', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      // eslint-disable-next-line carrier-fields-verifier/carrier-fields
      carrier['x-datadog-trace-id'] = value
    `, { filePath: 'packages/dd-trace/src/example.js' })

    assert.ok(result.messages.some(message => message.ruleId === 'carrier-fields-verifier/carrier-fields'))
  })

  it('enforces managed-header access in every production package', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      const traceIdHeader = 'x-datadog-trace-id'
      attributes[traceIdHeader] = value
    `, { filePath: 'packages/datadog-plugin-example/src/index.js' })

    assert.ok(result.messages.some(message => message.ruleId === 'carrier-fields-verifier/carrier-fields'))
  })

  it('does not allow inline comments to suppress direct carrier access in the propagation core', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      // eslint-disable-next-line carrier-fields-verifier/carrier-fields
      carrier[key] = value
    `, { filePath: 'packages/dd-trace/src/datastreams/pathway.js' })

    assert.ok(result.messages.some(message => message.ruleId === 'carrier-fields-verifier/carrier-fields'))
  })
})
