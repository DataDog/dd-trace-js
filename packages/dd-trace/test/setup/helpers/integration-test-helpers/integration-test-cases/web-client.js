'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class WebClientTestHelper extends BaseTestHelper {
    generateTestCases () {
        super.generateTestCases()

        describe('basic HTTP client operations', () => {
            it('should instrument HTTP GET requests', async () => {
                this.agent
                    .assertSomeTraces(traces => {
                        expect(traces[0][0]).to.deep.include({
                            service: 'test'
                        })
                        expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                        expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                        expect(traces[0][0].meta).to.have.property('http.url')
                        expect(traces[0][0].meta).to.have.property('http.status_code')
                        expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                    })

                await this.testSetup.request({ method: 'GET', url: 'http://localhost:8080/test' })
            })

            it('should instrument HTTP POST requests', async () => {
                this.agent
                    .assertSomeTraces(traces => {
                        expect(traces[0][0].meta).to.have.property('http.method', 'POST')
                        expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                    })

                await this.testSetup.request({ method: 'POST', url: 'http://localhost:8080/test' })
            })

            it('should handle HTTP errors', async () => {
                const agentAssertion = this.agent
                    .assertSomeTraces(traces => {
                        const errorSpan = traces.flat().find(span => span.error === 1)
                        expect(errorSpan).to.exist
                        expect(errorSpan.meta).to.have.property('component', this.pluginName)
                    })

                try {
                    await this.testSetup.request({ url: 'http://localhost:8080/error', expectError: true })
                } catch (e) {
                    // expected
                }

                return agentAssertion
            })
        })
    }
}

module.exports = { WebClientTestHelper }



