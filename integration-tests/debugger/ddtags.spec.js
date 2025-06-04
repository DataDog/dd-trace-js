'use strict'

const os = require('os')

const { assert } = require('chai')
const { setup } = require('./utils')
const { version } = require('../../package.json')

describe('Dynamic Instrumentation', function () {
  describe('ddtags', function () {
    describe('basic case', function () {
      const t = setup({
        env: {
          DD_ENV: 'test-env',
          DD_VERSION: 'test-version',
          DD_GIT_COMMIT_SHA: 'test-commit-sha',
          DD_GIT_REPOSITORY_URL: 'test-repository-url'
        },
        testApp: 'target-app/basic.js',
        dependencies: ['fastify']
      })

      it('should add the expected ddtags as a query param to /debugger/v1/input', function (done) {
        t.triggerBreakpoint()

        t.agent.on('debugger-input', ({ query }) => {
          assert.property(query, 'ddtags')

          const ddtags = extractDDTagsFromQuery(query)

          assert.hasAllKeys(ddtags, [
            'env',
            'version',
            'debugger_version',
            'host_name',
            'git.commit.sha',
            'git.repository_url'
          ])

          assert.strictEqual(ddtags.env, 'test-env')
          assert.strictEqual(ddtags.version, 'test-version')
          assert.strictEqual(ddtags.debugger_version, version)
          assert.strictEqual(ddtags.host_name, os.hostname())
          assert.strictEqual(ddtags['git.commit.sha'], 'test-commit-sha')
          assert.strictEqual(ddtags['git.repository_url'], 'test-repository-url')

          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })

    describe('with undefined values', function () {
      const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

      it('should not include undefined values in the ddtags query param', function (done) {
        t.triggerBreakpoint()

        t.agent.on('debugger-input', ({ query }) => {
          assert.property(query, 'ddtags')

          const ddtags = extractDDTagsFromQuery(query)

          assert.hasAllKeys(ddtags, [
            'debugger_version',
            'host_name'
          ])

          done()
        })

        t.agent.addRemoteConfig(t.rcConfig)
      })
    })
  })
})

// Before: "a:b,c:d"
// After: { a: 'b', c: 'd' }
function extractDDTagsFromQuery (query) {
  return query.ddtags
    .split(',')
    .map((tag) => tag.split(':'))
    .reduce((acc, [k, v]) => { acc[k] = v; return acc }, {})
}
