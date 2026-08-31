import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it } from 'mocha'
import sinon from 'sinon'

import { createCarrierFieldsEslint, verifyCarrierFields } from './verify-carrier-fields.mjs'

describe('verify-carrier-fields', () => {
  it('does not allow inline comments to suppress managed-header access', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      // eslint-disable-next-line eslint-rules/eslint-carrier-fields
      return carrier['x-datadog-trace-id'] = value
    `, { filePath: 'packages/dd-trace/src/example.js' })

    assert.ok(result.messages.some(message => message.ruleId === 'eslint-rules/eslint-carrier-fields'))
  })

  it('enforces managed-header access in every production package', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      import 'node:fs'
      const traceIdHeader = 'x-datadog-trace-id'
      attributes[traceIdHeader] = value
    `, { filePath: 'packages/datadog-plugin-example/src/index.mjs' })

    assert.ok(result.messages.some(message => message.ruleId === 'eslint-rules/eslint-carrier-fields'))
  })

  it('does not allow inline comments to suppress direct carrier access in the propagation core', async () => {
    const eslint = createCarrierFieldsEslint(process.cwd())
    const [result] = await eslint.lintText(`
      // eslint-disable-next-line eslint-rules/eslint-carrier-fields
      carrier[key] = value
    `, { filePath: 'packages/dd-trace/src/datastreams/pathway.js' })

    assert.ok(result.messages.some(message => message.ruleId === 'eslint-rules/eslint-carrier-fields'))
  })

  it('returns a failure and formats violations', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'dd-trace-carrier-fields-'))
    const sourceDirectory = path.join(cwd, 'packages/example/src')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(path.join(sourceDirectory, 'index.cjs'), 'carrier["x-datadog-trace-id"] = value\n')
    const consoleError = sinon.stub(console, 'error')

    try {
      assert.strictEqual(await verifyCarrierFields(cwd), 1)
      assert.match(consoleError.firstCall.args[0], /Use the matching named operation from carrier\.js/)
    } finally {
      consoleError.restore()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
