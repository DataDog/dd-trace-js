'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class WebServerTestHelper extends BaseTestHelper {
    generateTestCases () {
        super.generateTestCases()

        it('should instrument HTTP GET requests', async () => {
            const agentAssertion = this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.deep.include({
                        service: 'test'
                    })
                    expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                    expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                    expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                    expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                })

            await this.testSetup.handle_request({ method: 'GET', path: '/' })
            return agentAssertion
        })

        it('should instrument HTTP POST requests', async () => {
            const agentAssertion = this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.deep.include({
                        service: 'test'
                    })
                    expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                    expect(traces[0][0].meta).to.have.property('http.method', 'POST')
                    expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                    expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                })

            await this.testSetup.handle_request({ method: 'POST', path: '/' })
            return agentAssertion
        })

        it('should instrument parameterized routes', async () => {
            const agentAssertion = this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0].meta).to.have.property('http.route')
                })

            await this.testSetup.handle_request({ method: 'GET', path: '/users/123' })
            return agentAssertion
        })

        it('should handle HTTP error responses', async () => {
            const agentAssertion = this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.have.property('error', 1)
                    expect(traces[0][0].meta).to.have.property('http.status_code', '500')
                })

            await this.testSetup.handle_request({ method: 'GET', path: '/', expectError: true })
            return agentAssertion
        })
    }
}

module.exports = { WebServerTestHelper }
