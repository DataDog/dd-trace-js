'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

for (const scenario of [
  { enabled: true, obfuscation: 'width=[^&]*', query: '?<redacted>&height=200' },
  { enabled: true, obfuscation: false, query: '?width=100&height=200' },
  { enabled: true, obfuscation: true, query: '' },
  { enabled: false, obfuscation: false, query: '' },
]) {
  describe(`Storage query: semantics=${scenario.enabled}, obfuscation=${scenario.obfuscation}`, () => {
    const setup = new TestSetup()

    before(() => {
      process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = String(scenario.enabled)
    })

    after(() => {
      delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
    })

    createIntegrationTestSuite('supabase', '@supabase/supabase-js', {
      pluginConfig: { queryStringObfuscation: scenario.obfuscation },
    }, meta => {
      before(() => setup.setup(meta.mod))
      after(() => setup.teardown())

      for (const credentials of [false, true]) {
        it(`exports configured query data and redacts credentials=${credentials}`, async () => {
          const path = '/storage/v1/render/image/authenticated/files/avatar.png'
          const assertion = meta.agent.assertFirstTraceSpan(span => {
            assert.strictEqual(span.name, 'supabase.storage.request')
            assert.strictEqual(span.resource, 'GET render/image')
            if (scenario.enabled) {
              const authority = credentials ? 'REDACTED:REDACTED@project.supabase.co' : 'project.supabase.co'
              assert.strictEqual(span.meta['url.full'], `https://${authority}${path}${scenario.query}`)
              assert.strictEqual(span.meta['http.request.method'], 'GET')
              assert.strictEqual(span.meta['http.url'], undefined)
            } else {
              const authority = credentials ? 'user:secret@project.supabase.co' : 'project.supabase.co'
              assert.strictEqual(span.meta['http.url'], `https://${authority}${path}`)
              assert.strictEqual(span.meta['url.full'], undefined)
            }
          })
          const request = setup.storageFileDownloadWithTransform(credentials
            ? { url: 'https://user:secret@project.supabase.co' }
            : undefined)
          const [result] = await Promise.all([request, assertion])
          assert.ifError(result.error)
        })
      }
    })
  })
}
