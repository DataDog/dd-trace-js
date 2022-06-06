'use strict'

const {
    addHook,
    channel,
    AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const documentSources = new WeakMap()

// config validator helpers

function validateConfig(config) {
    return Object.assign({}, config, {
        depth: getDepth(config),
        variables: getVariablesFilter(config),
        collapse: config.collapse === undefined || !!config.collapse,
        hooks: getHooks(config)
    })
}

function getDepth(config) {
    if (typeof config.depth === 'number') {
        return config.depth
    } else if (config.hasOwnProperty('depth')) {
        log.error('Expected `depth` to be a integer.')
    }
    return -1
}

function getVariablesFilter(config) {
    if (typeof config.variables === 'function') {
        return config.variables
    } else if (config.variables instanceof Array) {
        return variables => pick(variables, config.variables)
    } else if (config.hasOwnProperty('variables')) {
        log.error('Expected `variables` to be an array or function.')
    }
    return null
}

function getHooks(config) {
    const noop = () => { }
    const execute = (config.hooks && config.hooks.execute) || noop
    const parse = (config.hooks && config.hooks.parse) || noop
    const validate = (config.hooks && config.hooks.validate) || noop

    return { execute, parse, validate }
}

// non-lodash pick
function pick(obj, selectors) {
    return Object.fromEntries(Object.entries(obj).filter(([key]) => selectors.includes(key)))
}

function getOperation(document, operationName) {
    if (!document || !Array.isArray(document.definitions)) {
        return
    }

    const definitions = document.definitions.filter(def => def)
    const types = ['query', 'mutation', 'subscription']

    if (operationName) {
        return definitions
            .filter(def => types.indexOf(def.operation) !== -1)
            .find(def => operationName === (def.name && def.name.value))
    } else {
        return definitions.find(def => types.indexOf(def.operation) !== -1)
    }
}

function getOperation(document, operationName) {
    if (!document || !Array.isArray(document.definitions)) {
        return
    }

    const definitions = document.definitions.filter(def => def)
    const types = ['query', 'mutation', 'subscription']

    if (operationName) {
        return definitions
            .filter(def => types.indexOf(def.operation) !== -1)
            .find(def => operationName === (def.name && def.name.value))
    } else {
        return definitions.find(def => types.indexOf(def.operation) !== -1)
    }
}

addHook({ name: 'graphql', file: 'language/parser.js', versions: ['>=0.10'] }, parser => {

    const conf = validateConfig(this.config)
    
    const startCh = channel('apm:graphql:parser:start')
    const finishCh = channel('apm:graphql:parser:finish')
    const errorCh = channel('apm:graphql:parser:error')

    shimmer.wrap(parser, 'parse', parse => function (source) {
        if (!startCh.hasSubscribers) {
            return parse.apply(this, arguments)
        }

        startCh.publish({ conf })
        let document
        try {
            document = parse.apply(this, arguments)
            const operation = getOperation(document)

            if (!operation) return document

            if (source) {
                documentSources.set(document, source.body || source)
            }

        } catch (err) {
            err.stack
            errorCh.publish(err)
        } finally {
            finishCh.publish({ source, document })
        }
    })
    return parser
})