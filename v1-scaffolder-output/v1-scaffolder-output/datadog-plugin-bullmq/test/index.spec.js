'use strict'

const { expect } = require('chai')
const { describe, it, before, after, beforeEach, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('bullmq', () => {
    withVersions('bullmq', 'bullmq', version => {
      beforeEach(() => {
        require('../../dd-trace')
      })

      describe('without configuration', () => {
        let mod
        let sc

        before(() => {
          return agent.load('bullmq')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          mod = require(`../../../versions/bullmq@${version}`).get()
          const { StringCodec } = mod
          // const nc = await connect(...)
          sc = StringCodec()
        })

        afterEach(async () => {
          // TODO: cleanup if needed
        })

        it('should do automatic instrumentation', done => {
          agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('service')
            expect(traces[0][0].meta).to.have.property('component')
          })
            .then(done)
            .catch(done)
        })

        it('should exercise methods of interest', async () => {
          if (!process.env.DD_EXAMPLE_RUN) return
          await (subIter && subIter.catch(() => {}))
          await nc.flush()
          await nc.drain()
          // TODO: add minimal assertions if desired
        })
      })

      // TODO: add custom test cases here
    })
  })
})
