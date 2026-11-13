'use strict'

const assert = require('node:assert/strict')
const { gunzipSync } = require('node:zlib')

const { satisfies } = require('semver')

const { NODE_MAJOR, NODE_MINOR, NODE_PATCH } = require('../../../../version')
const agent = require('../plugins/agent')
const { withVersions } = require('../setup/mocha')
const httpRequest = require('../setup/helpers/http-client')
const { initApp, startServer } = require('./next.utils')
const { getWebSpan } = require('./utils')

describe('Next.js response schemas', () => {
  withVersions('next', 'next', '>=11.1', version => {
    const realVersion = require(`../../../../versions/next@${version}`).version()
    if (satisfies(realVersion, '>=12 <13') && NODE_MAJOR === 24 && NODE_MINOR === 0 && NODE_PATCH === 0) return
    if (satisfies(realVersion, '>=12 <13') && NODE_MAJOR >= 26) return
    if (satisfies(realVersion, '>=16') && NODE_MAJOR < 20) return

    const apps = [{ appName: 'pages-dir', serverPath: 'server' }]
    // Next 13.2 clears the final status of dynamic App Router responses, preventing request-end schema extraction.
    if (satisfies(realVersion, '>=13.3')) {
      apps.push({ appName: 'app-dir', serverPath: '.next/standalone/server.js' })
    }

    for (const { appName, serverPath } of apps) {
      describe(appName, () => {
        initApp(appName, version, realVersion)
        const serverData = startServer(appName, serverPath, version, '../datadog-api-security.js')

        const modes = appName === 'pages-dir' ? ['json', 'send'] : ['json']
        for (const mode of modes) {
          it(`extracts the response schema for ${mode} without changing the body or status`, async () => {
            const [response] = await Promise.all([
              httpRequest.get(`http://127.0.0.1:${serverData.port}/api/response-schema?mode=${mode}`),
              agent.assertSomeTraces(traces => {
                const span = getWebSpan(traces)
                assert.strictEqual(span.meta['http.status_code'], '201')
                const encoded = span.meta['_dd.appsec.s.res.body']
                assert.ok(encoded, 'missing response body schema')
                assert.deepStrictEqual(JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'))), [{ value: [8] }])
              }),
            ])
            assert.strictEqual(response.status, 201)
            assert.deepStrictEqual(response.data, { value: 'café' })
          })
        }

        for (const mode of ['text', 'empty', 'scalar']) {
          it(`omits the response body schema for ${mode} responses`, async () => {
            const [response] = await Promise.all([
              httpRequest.get(`http://127.0.0.1:${serverData.port}/api/response-schema?mode=${mode}`),
              agent.assertSomeTraces(traces => {
                const span = getWebSpan(traces)
                assert.strictEqual(span.meta['http.status_code'], mode === 'empty' ? '204' : '201')
                assert.strictEqual(span.meta['_dd.appsec.s.res.body'], undefined)
              }),
            ])
            assert.strictEqual(response.status, mode === 'empty' ? 204 : 201)
          })
        }
      })
    }
  })
})
