'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class CustomTestHelper extends BaseTestHelper {
  generateTestCases () {
    super.generateTestCases()

    describe('basic custom operations', () => {
      it('should instrument custom operations', async () => {
        this.agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.deep.include({
              service: 'test'
            })
            expect(traces[0][0].meta).to.have.property('component', this.pluginName)
            expect(traces[0][0].meta).to.have.property('span.kind')
          })

        await this.testSetup.operation({ operation_name: 'custom-operation' })
      })

      it('should handle operation errors', async () => {
        const agentAssertion = this.agent
          .assertSomeTraces(traces => {
            const errorSpan = traces.flat().find(span => span.error === 1)
            expect(errorSpan).to.exist
            expect(errorSpan.meta).to.have.property('component', this.pluginName)
          })

        try {
          await this.testSetup.operation({ operation_name: 'error-operation', expectError: true })
        } catch (e) {
          // expected
        }

        return agentAssertion
      })
    })
  }
}

module.exports = { CustomTestHelper }
