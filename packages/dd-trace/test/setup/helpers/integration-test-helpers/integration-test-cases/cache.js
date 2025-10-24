'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class CacheTestHelper extends BaseTestHelper {
    generateTestCases () {
        super.generateTestCases()

        describe('basic cache operations', () => {
            it('should instrument cache SET commands', async () => {
                this.agent
                    .assertSomeTraces(traces => {
                        expect(traces[0][0]).to.deep.include({
                            service: 'test'
                        })
                        expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                        expect(traces[0][0].meta).to.have.property('db.system')
                        expect(traces[0][0].meta).to.have.property('db.operation')
                        expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                    })

                await this.testSetup.set({ key: 'test-key', value: 'test-value' })
            })

            it('should instrument cache GET commands', async () => {
                this.agent
                    .assertSomeTraces(traces => {
                        expect(traces[0][0].meta).to.have.property('db.system')
                        expect(traces[0][0].meta).to.have.property('db.operation')
                        expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                    })

                await this.testSetup.get({ key: 'test-key' })
            })

            it('should instrument cache DELETE commands', async () => {
                this.agent
                    .assertSomeTraces(traces => {
                        expect(traces[0][0].meta).to.have.property('db.system')
                        expect(traces[0][0].meta).to.have.property('db.operation')
                        expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                    })

                await this.testSetup.delete({ key: 'test-key' })
            })

            it('should handle cache command errors', async () => {
                const agentAssertion = this.agent
                    .assertSomeTraces(traces => {
                        const errorSpan = traces.flat().find(span => span.error === 1)
                        expect(errorSpan).to.exist
                        expect(errorSpan.meta).to.have.property('component', this.pluginName)
                    })

                try {
                    await this.testSetup.command({ command: 'GET', key: 'invalid-key', expectError: true })
                } catch (e) {
                    // expected
                }

                return agentAssertion
            })
        })
    }
}

module.exports = { CacheTestHelper }



