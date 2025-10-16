'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class WebServerTestHelper extends BaseTestHelper {
    generateTestCases () {
        super.generateTestCases()

        it('should instrument HTTP GET requests', function (done) {
            this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.deep.include({
                        service: 'test'
                    })
                    expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                    expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                    expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                    expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                })
                .then(done)
                .catch(done)

            this.testSetup.handle_request({ method: 'GET', path: '/' }).catch(done)
        })

        it('should instrument HTTP POST requests', function (done) {
            this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.deep.include({
                        service: 'test'
                    })
                    expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                    expect(traces[0][0].meta).to.have.property('http.method', 'POST')
                    expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                    expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                })
                .then(done)
                .catch(done)

            this.testSetup.handle_request({ method: 'POST', path: '/' }).catch(done)
        })

        it('should instrument parameterized routes', function (done) {
            this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0].meta).to.have.property('http.route')
                })
                .then(done)
                .catch(done)

            this.testSetup.handle_request({ method: 'GET', path: '/users/123' }).catch(done)
        })

        it('should handle HTTP error responses', function (done) {
            this.agent
                .assertSomeTraces(traces => {
                    expect(traces[0][0]).to.have.property('error', 1)
                    expect(traces[0][0].meta).to.have.property('http.status_code', '500')
                })
                .then(done)
                .catch(done)

            this.testSetup.handle_request({ method: 'GET', path: '/', expectError: true }).catch(() => {})
        })
    }
}

module.exports = { WebServerTestHelper }
