'use strict'

require('../src/knex')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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
          storage('legacy').run(store, () =>
            client.raw('PRAGMA user_version')
              .finally(() => {
                expect(storage('legacy').getStore()).to.equal(store)
              })
              .catch(() => {})
          )
        )
      })
    })
  })
})
