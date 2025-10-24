'use strict'

const { expect } = require('chai')
const { it } = require('mocha')
const { validateTestSetupImplementation, loader } = require('../operation-validator')

class BaseTestHelper {
    constructor (config) {
        this.pluginName = config.pluginName
        this.packageName = config.packageName
        this.testSetup = config.testSetup
        this.agent = config.agent
        this.tracer = config.tracer
        this.category = config.category
        this.role = config.role
    }

    static getOperations (category, role) {
        // Special case: messaging integrations typically implement both producer and consumer
        if (category === 'messaging') {
            const producerRequired = loader.getRequiredOperations(category, 'producer')
            const producerOptional = loader.getOptionalOperations(category, 'producer')
            const consumerRequired = loader.getRequiredOperations(category, 'consumer')
            const consumerOptional = loader.getOptionalOperations(category, 'consumer')

            return {
                required: [...new Set([...producerRequired, ...consumerRequired])],
                optional: [...new Set([...producerOptional, ...consumerOptional])]
            }
        }

        const required = loader.getRequiredOperations(category, role)
        const optional = loader.getOptionalOperations(category, role)
        return { required, optional }
    }

    validateTestSetup () {
        validateTestSetupImplementation(this.testSetup, this.category, this.role)
    }

    generateTestCases () {
        it('should load the module correctly', () => {
            expect(this.mod).to.exist
            expect(this.testSetup).to.be.an('object')
        })

        it('should implement all required operations', () => {
            this.validateTestSetup()
        })

        it('should create spans for instrumented operations', (done) => {
            // Get the first required operation and call it
            const operations = BaseTestHelper.getOperations(this.category, this.role)
            const firstOperation = operations.required[0]

            if (!firstOperation || typeof this.testSetup[firstOperation] !== 'function') {
                done()
                return
            }

            this.agent
                .assertSomeTraces(traces => {
                    expect(traces).to.have.length.greaterThan(0)
                    expect(traces[0]).to.have.length.greaterThan(0)
                    expect(traces[0][0]).to.have.property('name')
                    expect(traces[0][0]).to.have.property('service', 'test')
                    expect(traces[0][0].meta).to.have.property('component', this.pluginName)
                })
                .then(done)
                .catch(done)

            // Call the first required operation with empty args
            // The operation validator will add expectError: false by default
            this.testSetup[firstOperation]({}).catch(done)
        })
    }
}

module.exports = { BaseTestHelper }