'use strict'

// TODO: fix tests failing when re-running in watch mode

const agent = require('./agent')
const plugin = require('../../src/plugins/knex')

wrapIt()

describe('Plugin', () => {
  let knex
  let client
  let tracer

  describe('knex', () => {
    withVersions(plugin, 'knex', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, ['knex'])
            .then(() => {
              knex = require(`../../versions/knex@${version}`).get()
              client = knex({
                client: 'sqlite3',
                connection: {
                  filename: ':memory:'
                }
              })
            })
        })
        it('should propagate context', () => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

          const span = {}

          return tracer.scope().activate(span, () => {
            return client.raw('PRAGMA user_version')
              .then(() => {
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })
      })
    })
  })
})
