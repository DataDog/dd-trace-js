'use strict'

const {
    addHook,
    channel,
    AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const documentSources = new WeakMap()

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

    const conf = this.config

    const startCh = channel('apm:graphql:parser:start')
    const finishCh = channel('apm:graphql:parser:finish')
    const errorCh = channel('apm:graphql:parser:error')
    // need async resource for this even though no call wrapper used in original?
    shimmer.wrap(parser, 'parse', parse => function (source) {
        if (!startCh.hasSubscribers) {
            return parse.apply(this, arguments)
        }

        startCh.publish()
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

            throw err
        } finally {
            finishCh.publish({ source, document, docSource: documentSources.get(document) })
        }
    })
    return parser
})

addHook({ name: 'graphql', file: 'validation/validate.js', versions: ['>=0.10'] }, validate => {
    const conf = this.config

    const startCh = channel('apm:graphql:validate:start')
    const finishCh = channel('apm:graphql:validate:finish')
    const errorCh = channel('apm:graphql:validate:error')

    shimmer.wrap(validate, 'validate', val => function (_schema, document, _rules, _typeInfo) {
        if (!startCh.hasSubscribers) {
            return val.apply(this, arguments)
        }

        startCh.publish({ docSource: documentSources.get(document), document })

        let errors
        try {
            errors = val.apply(this, arguments)
            errorCh.publish(errors && errors[0])
            return errors
        } catch (err) {
            err.stack
            errorCh.publish(err)

            throw err
        } finally {
            finishCh.publish({ document, errors })
        }
    })

    return validate
})