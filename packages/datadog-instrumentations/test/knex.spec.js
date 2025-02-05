'use strict'

require('../src/knex')
const { storage, SPAN_NAMESPACE } = require('../../datadog-core')

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
          storage(SPAN_NAMESPACE).run(store, () =>
            client.raw('PRAGMA user_version')
              .finally(() => {
                expect(storage(SPAN_NAMESPACE).getStore()).to.equal(store)
              })
              .catch(() => {})
          )
        )
      })
    })
  })
})
