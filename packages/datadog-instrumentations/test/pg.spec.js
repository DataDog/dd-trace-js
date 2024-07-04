'use strict'

const assert = require('assert')
const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')

function abortListener ({ abortController }) {
  abortController.abort(new Error('Aborted in test'))
}

describe('pg', () => {
  const clientStartCh = channel('apm:pg:query:start')
  const clientFinishCh = channel('apm:pg:query:finish')
  const clientErrorCh = channel('apm:pg:query:error')

  const poolStartCh = channel('datadog:pg:pool:query:start')
  const poolFinishCh = channel('datadog:pg:pool:query:finish')

  let clientStart, clientFinish, clientError, poolFinish

  const pgConfig = {
    host: '127.0.0.1',
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    application_name: 'test'
  }
  let pg

  beforeEach(() => {
    clientStart = sinon.stub()
    clientFinish = sinon.stub()
    clientError = sinon.stub()
    poolFinish = sinon.stub()

    clientStartCh.subscribe(clientStart)
    clientFinishCh.subscribe(clientFinish)
    clientErrorCh.subscribe(clientError)
    poolFinishCh.subscribe(poolFinish)
  })

  afterEach(() => {
    if (clientStartCh.hasSubscribers) clientStartCh.unsubscribe(abortListener)
    if (clientFinishCh.hasSubscribers) clientFinishCh.unsubscribe(abortListener)
    if (clientErrorCh.hasSubscribers) clientErrorCh.unsubscribe(abortListener)
    if (poolStartCh.hasSubscribers) poolStartCh.unsubscribe(abortListener)
    if (poolFinishCh.hasSubscribers) poolFinishCh.unsubscribe(abortListener)
  })

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
      let client

      beforeEach((done) => {
        client = new pg.Client(pgConfig)
        client.connect(err => done(err))
      })

      afterEach((done) => {
        client.end(done)
      })

      describe('promise', () => {
        it('query is not aborted', async () => {
          await client.query('SELECT 1')
          sinon.assert.notCalled(clientError)
        })

        it('query is aborted', async () => {
          clientStartCh.subscribe(abortListener)

          try {
            await client.query('SELECT 1')

            assert.fail('Query should have been aborted')
          } catch (e) {
            assert.equal(e.message, 'Aborted in test')
            sinon.assert.calledOnce(clientError)
            sinon.assert.calledOnce(clientFinish)
          }
        })
      })

      describe('callback', () => {
        it('query is not aborted', (done) => {
          client.query('SELECT 1', function (e) {
            if (e) {
              done(e)
              return
            }

            sinon.assert.notCalled(clientError)
            done()
          })
        })

        it('query is aborted', (done) => {
          clientStartCh.subscribe(abortListener)

          client.query('SELECT 1', function (e) {
            if (e) {
              try {
                assert.equal(e.message, 'Aborted in test')
                sinon.assert.calledOnce(clientError)
                sinon.assert.calledOnce(clientFinish)

                done()
              } catch (e) {
                done(e)
              }
              return
            }

            done(new Error('Query should have been aborted'))
          })
        })
      })
    })

    describe('Pool', () => {
      let pool

      beforeEach(() => {
        pool = new pg.Pool(pgConfig)
      })

      describe('promise', () => {
        it('query is not aborted', async () => {
          await pool.query('SELECT 1')
          sinon.assert.calledOnce(clientStart)
          sinon.assert.notCalled(clientError)
          sinon.assert.calledOnce(clientFinish)
          sinon.assert.calledOnce(poolFinish)
        })

        it('query is aborted', async () => {
          poolStartCh.subscribe(abortListener)

          try {
            await pool.query('SELECT 1')

            assert.fail('Query should have been aborted')
          } catch (e) {
            assert.equal(e.message, 'Aborted in test')
            sinon.assert.notCalled(clientStart)
            sinon.assert.notCalled(clientError)
            sinon.assert.notCalled(clientFinish)
            sinon.assert.calledOnce(poolFinish)
          }
        })
      })

      describe('callback', () => {
        it('query is not aborted', (done) => {
          pool.query('SELECT 1', function (e) {
            if (e) {
              done(e)
              return
            }

            sinon.assert.calledOnce(clientStart)
            sinon.assert.notCalled(clientError)
            sinon.assert.calledOnce(clientFinish)
            sinon.assert.calledOnce(poolFinish)
            done()
          })
        })

        it('query is aborted', (done) => {
          poolStartCh.subscribe(abortListener)

          pool.query('SELECT 1', function (e) {
            if (e) {
              try {
                assert.equal(e.message, 'Aborted in test')
                sinon.assert.notCalled(clientStart)
                sinon.assert.notCalled(clientError)
                sinon.assert.notCalled(clientFinish)
                sinon.assert.calledOnce(poolFinish)

                done()
              } catch (e) {
                done(e)
              }
              return
            }

            done(new Error('Query should have been aborted'))
          })
        })
      })
    })
  })
})
