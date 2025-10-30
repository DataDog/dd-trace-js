'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class MessagingTestHelper extends BaseTestHelper {
  generateTestCases () {
    super.generateTestCases()

    describe('basic messaging test operations', () => {
      describe('producer', () => {
        it('should instrument message production', async () => {
          this.agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.deep.include({
                service: 'test'
              })
              expect(traces[0][0].meta).to.have.property('component', this.pluginName)
              expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
              expect(traces[0][0].meta).to.have.property('messaging.operation', 'produce')
              expect(traces[0][0].meta).to.have.property('messaging.destination.name')
              expect(traces[0][0].meta).to.have.property('messaging.system', this.pluginName)
            })

          process.nextTick(async () => await this.testSetup.produce({ destination: 'test-queue', message: 'test' }).catch())
        })

        it('should handle errors in message production', async () => {
          const agentAssertion = this.agent
            .assertSomeTraces(traces => {
              const errorSpan = traces.flat().find(span => span.error === 1)
              expect(errorSpan).to.exist
              expect(errorSpan.meta).to.have.property('component', this.pluginName)
            })

          try {
            await this.testSetup.produce({ destination: 'test-queue', message: 'test', expectError: true })
          } catch (e) {
            // expected
          }

          await new Promise(resolve => setTimeout(resolve, 200))

          return agentAssertion
        })
      })

      describe('consumer', () => {
        it('should instrument message consumption', async () => {
          const agentAssertion = this.agent
            .assertSomeTraces(traces => {
              expect(traces).to.have.length.greaterThan(0)
              const consumerSpan = traces.flat()[traces.flat().length - 1]
              expect(consumerSpan).to.exist
              expect(consumerSpan.meta).to.have.property('component', this.pluginName)
              // expect(consumerSpan.meta).to.have.property('messaging.operation', 'consume')
              // expect(consumerSpan.meta).to.have.property('messaging.destination.name')
              // expect(consumerSpan.meta).to.have.property('messaging.system', this.pluginName)
            })

          await this.testSetup.produce({ destination: 'test-queue', message: 'test' })
            .then(async () => await this.testSetup.consume({ destination: 'test-queue' }))
            .catch()

          return agentAssertion
        })

        it('should instrument message processing', async () => {
          const agentAssertion = this.agent
            .assertSomeTraces(traces => {
              expect(traces).to.have.length.greaterThan(0)
              const spans = traces.flat()
              const processSpan = spans.find(span => span.meta && span.meta['messaging.operation'] === 'process')
              expect(processSpan).to.exist
              expect(processSpan.meta).to.have.property('component', this.pluginName)
            })

          await this.testSetup.produce({ destination: 'test-queue', message: 'test' })
            .then(async () => await this.testSetup.process({ destination: 'test-queue' }))

          return agentAssertion
        })

        it('should handle errors in message consumption', async () => {
          const agentAssertion = this.agent
            .assertSomeTraces(traces => {
              const errorSpan = traces.flat().find(span => span.error === 1)
              expect(errorSpan).to.exist
              expect(errorSpan.meta).to.have.property('component', this.pluginName)
            })

          let threw = false
          try {
            await this.testSetup.consume({ destination: 'test-queue', expectError: true })
          } catch (e) {
            threw = true
          }
          expect(threw).to.equal(true)
          return agentAssertion
        })
      })
    })
  }
}

module.exports = { MessagingTestHelper }
