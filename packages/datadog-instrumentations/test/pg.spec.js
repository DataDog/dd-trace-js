'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
describe('pg', () => {
  let pg

  withVersions('pg', 'pg', version => {
    before(() => {
      return agent.load('pg')
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      pg = require(`../../../versions/pg@${version}`).get()
    })

    describe('Client', () => {
      describe('promise', () => {
        it('hello', () => {})
      })
      describe('callback', () => {
        it('UEEEEEEEADSFADSFDASFDSAFAS', () => {})
      })
    })

    describe('Pool', () => {
      describe('promise', () => {

      })
      describe('callback', () => {

      })
    })
  })
})
