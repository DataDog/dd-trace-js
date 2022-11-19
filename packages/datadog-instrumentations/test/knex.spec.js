'use strict'

require('../../dd-trace/test/setup/tap')

require('../src/knex')
const { storage } = require('../../datadog-core')

describe('Instrumentation', () => {
  let knex
  let client
  const store = 'store'

  describe('knex', () => {
    withVersions('knex', 'knex', version => {
      describe('without configuration', () => {
        beforeEach(() => {
          knex = require(`../../../versions/knex@${version}`).get()
          client = knex({
            client: 'pg',
            connection: {
              filename: ':memory:'
            }
          })
        })
        afterEach(() => client.destroy())

        it('should propagate context', () =>
          storage.run(store, () =>
            client.raw('PRAGMA user_version')
              .finally(() => {
                expect(storage.getStore()).to.equal(store)
              })
              .catch(() => {})
          )
        )
      })
    })
  })
})
