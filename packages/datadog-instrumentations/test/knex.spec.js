'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Instrumentation', () => {
  let knex
  let client
  const store = 'store'

  describe('knex', () => {
    withVersions('knex', 'knex', version => {
      describe('without configuration', () => {
        // TODO: This test fails installing sqlite3 in the CI but the test is green!
        /**
         * TODO (Pablo Erhard): Implement a single mechanism to automatically trigger hook loading
         * across all tests. This should allow test hooks to initialize programmatically
         * without requiring explicit `agent.load()` calls in every individual test file.
         */
        before(async () => {
          await agent.load()
        })

        beforeEach(() => {
          knex = require(`../../../versions/knex@${version}`).get()
          client = knex({
            client: 'sqlite3',
            connection: {
              filename: ':memory:',
            },
          })
        })

        afterEach(() => client.destroy())
        after(async () => {
          await agent.close()
        })

        it('should propagate context', async () => {
          let isInstrumented = false

          await storage('legacy').run(store, () =>
            client.raw('PRAGMA user_version').then(() => {
              isInstrumented = storage('legacy').getStore() === store
            }).catch(() => {})
          )

          assert.strictEqual(isInstrumented, true)
        })
      })
    })
  })
})
