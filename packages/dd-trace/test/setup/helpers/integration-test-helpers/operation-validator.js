'use strict'

const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')

/**
 * Loads and caches operation definitions from YAML files
 */
class OperationDefinitionLoader {
    constructor () {
        this.cache = new Map()
        this.semanticsDir = path.join(__dirname, '../../../../../../apm-semantics/operations')
    }

    load (category) {
        if (this.cache.has(category)) {
            return this.cache.get(category)
        }

        const filePath = path.join(this.semanticsDir, `${category}.yml`)

        if (!fs.existsSync(filePath)) {
            throw new Error(`Operation definitions not found for category: ${category}`)
        }

        const content = fs.readFileSync(filePath, 'utf8')
        const definitions = yaml.load(content)

        this.cache.set(category, definitions)
        return definitions
    }

    getOperation (category, operationName) {
        const definitions = this.load(category)
        const operation = definitions.operations?.[operationName]

        if (!operation) {
            throw new Error(`Operation '${operationName}' not found in category '${category}'`)
        }

        return operation
    }

    getRequiredOperations (category, role) {
        const definitions = this.load(category)
        return definitions.roles?.[role]?.required_operations || []
    }

    getOptionalOperations (category, role) {
        const definitions = this.load(category)
        return definitions.roles?.[role]?.optional_operations || []
    }
}

const loader = new OperationDefinitionLoader()

/**
 * Validates operation arguments against the schema defined in YAML
 */
function validateOperationArgs (category, operationName, args) {
    const operation = loader.getOperation(category, operationName)
    const schema = operation.test_action?.args || {}

    const errors = []

    // Check required arguments
    for (const [argName, argDef] of Object.entries(schema)) {
        if (argDef.required && !(argName in args)) {
            errors.push({
                argument: argName,
                message: `Missing required argument '${argName}'`,
                description: argDef.description
            })
        }

        // Type validation
        if (argName in args) {
            const actualType = Array.isArray(args[argName]) ? 'array' : typeof args[argName]

            // Handle anyOf (multiple allowed types)
            if (argDef.anyOf) {
                const allowedTypes = argDef.anyOf.map(t => t.type)
                if (!allowedTypes.includes(actualType)) {
                    errors.push({
                        argument: argName,
                        message: `Expected '${argName}' to be one of [${allowedTypes.join(', ')}], got ${actualType}`,
                        value: args[argName]
                    })
                }
            }
            // Handle single type
            else if (argDef.type && actualType !== argDef.type) {
                errors.push({
                    argument: argName,
                    message: `Expected '${argName}' to be ${argDef.type}, got ${actualType}`,
                    value: args[argName]
                })
            }
        }
    }

    // Always ensure expectError exists
    if (!('expectError' in args)) {
        args.expectError = false
    }

    if (errors.length > 0) {
        const errorDetails = errors.map(e => `  - ${e.message}${e.description ? ` (${e.description})` : ''}`).join('\n')
        throw new Error(
            `Invalid arguments for ${operationName}():\n` +
            `${errorDetails}\n\n` +
            `Received: ${JSON.stringify(args, null, 2)}\n` +
            `Expected schema: ${JSON.stringify(schema, null, 2)}`
        )
    }
}

/**
 * Creates a validated wrapper around a test setup class
 */
function createValidatedTestSetup (testSetup, category, role) {
    const requiredOps = loader.getRequiredOperations(category, role)
    const optionalOps = loader.getOptionalOperations(category, role)
    const allOps = [...requiredOps, ...optionalOps]

    return new Proxy(testSetup, {
        get (target, prop) {
            const value = target[prop]

            // Don't wrap non-functions or lifecycle methods
            if (typeof value !== 'function' || prop === 'setup' || prop === 'teardown') {
                return value
            }

            // Check if this is a defined operation
            if (!allOps.includes(prop)) {
                // Not a standard operation, pass through
                return value
            }

            // Wrap operation methods with validation
            return async function (...args) {
                const operationArgs = args[0] || {}

                // Validate arguments against YAML schema
                validateOperationArgs(category, prop, operationArgs)

                // Call original method with validated args
                return value.apply(target, [operationArgs])
            }
        }
    })
}

/**
 * Validates that a test setup implements all required operations
 */
function validateTestSetupImplementation (testSetup, category, role) {
    const requiredOps = loader.getRequiredOperations(category, role)
    const missing = []

    for (const op of requiredOps) {
        if (typeof testSetup[op] !== 'function') {
            missing.push(op)
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `Test setup for ${category}/${role} is missing required operations:\n` +
            `  ${missing.join(', ')}\n\n` +
            `Required operations: ${requiredOps.join(', ')}`
        )
    }
}

module.exports = {
    createValidatedTestSetup,
    validateTestSetupImplementation,
    validateOperationArgs,
    loader
}

