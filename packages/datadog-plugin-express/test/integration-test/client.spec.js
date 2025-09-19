'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const semver = require('semver')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  withVersions('express', 'express', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'express@${version}'`], false,
        ['./packages/datadog-plugin-express/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: 'import express from \'express\'',
        star: 'import * as starExpress from \'express\'; const express = starExpress.default;',
        destructure: 'import { default as express } from \'express\';'
      })
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })
    for (const variant of ['default', 'star', 'destructure']) {
      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED unset', () => {
        it('is instrumented', async () => {
          proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
          const numberOfSpans = semver.intersects(version, '<5.0.0') ? 4 : 2
          const whichMiddleware = semver.intersects(version, '<5.0.0')
            ? 'express'
            : 'router'

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
            assert.isArray(payload)
            assert.strictEqual(payload.length, 1)
            assert.isArray(payload[0])
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.propertyVal(payload[0][0], 'name', 'express.request')
            assert.propertyVal(payload[0][1], 'name', `${whichMiddleware}.middleware`)
          })
        }).timeout(50000)
      })

      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED=true', () => {
        before(() => {
          process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED = false
        })

        after(() => {
          delete process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED
        })

        it('disables middleware spans when config.middlewareTracingEnabled is false via env var', async () => {
          proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)
          const numberOfSpans = 1

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
            assert.isArray(payload)
            assert.strictEqual(payload.length, 1)
            assert.isArray(payload[0])
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.propertyVal(payload[0][0], 'name', 'express.request')
          })
        }).timeout(50000)
      })
    }
  })
})
