'use strict'

const {
    addHook,
    channel,
    AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const contexts = new WeakMap()
const documentSources = new WeakMap()
const patchedResolvers = new WeakSet()

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
function pathToArray(path) {
    const flattened = []
    let curr = path
    while (curr) {
        flattened.push(curr.key)
        curr = curr.prev
    }
    return flattened.reverse()
}

function withCollapse(responsePathAsArray) {
    return function () {
        return responsePathAsArray.apply(this, arguments)
            .map(segment => typeof segment === 'number' ? '*' : segment)
    }
}

function wrapResolve(resolve, config) {
    // need to return an asyncresource call here?
    if (typeof resolve !== 'function' || patchedResolvers.has(resolve)) return AsyncResource.bind(resolve)

    const responsePathAsArray = config.collapse ?
        withCollapse(pathToArray) :
        pathToArray

    function resolveAsync(_source, _args, contextValue, info) {
        const contest = contexts.get(contextValue)

        if (!context) return resolve.apply(this, arguments)

        const path = responsePathAsArray(info && info.path)

        if (config.depth >= 0) {
            const depth = path.filter(item => typeof item === 'string').length

            if (config.depth < depth) {
                // we don't care ab parent span, when we publish data, it will be to the parent span, which will spawn new span
                // but, OG was getParentField ... how exactly does that relate?

                return wrapFn(resolve, this, arguments)
            }

        }
        // publish data to channel, with data = {context, info, path} (contents of assertField), use childOf 
        return wrapFn(resolve, this, arguments, (err) => { })
    }

    patchedResolvers.add(resolveAsync)

    return resolveAsync
}

function wrapFn(fn, thisArg, args, cb) {

    cb = cb || (() => { })
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
        try {
            const result = fn.apply(thisArg, args)
            if (result && typeof result.then === 'function') {
                result.then(
                    res => cb(null, res),
                    err => cb(err)
                )
            }
            return result
        } catch (err) {
            cb(err)
            throw err
        }
    })
}

addHook({ name: 'graphql', file: 'execution/execute.js', versions: ['>=0.10'] }, execute => {

    const defaultFieldResolver = execute.defaultFieldResolver

    // const startCh = channel('apm:graphql:execute:start')
    const startResolveCh = channel('apm:graphql:execute:resolve:start')
    const executeCh = channel('apm:graphql:execute:execute')
    const finishCh = channel('apm:graphql:execute:finish')
    const errorCh = channel('apm:graphql:execute:error')

    shimmer.wrap(execute, 'execute', exe => function () {

        const asyncResource = new AsyncResource('bound-anonymous-fn')
        return asyncResource.runInAsyncScope(() => {
            const args = {} // TODO: put normalization here
            const schema = args.schema
            const document = args.document
            const source = documentSources.get(document)
            const contextValue = args.contextValue
            const operation = getOperation(document, args.operationName)

            if (contexts.has(contextValue)) {
                return exe.apply(this, arguments)
            }

            if (schema) {
                // wrap fields, will maybe call wrapResolve
            }

            // publish to channel to start execution span
            // QUESTION: how to use span started to add to context cache?

            return wrapFn(exe, this, arguments, (err, res) => { })
        })

    })
    return execute
})

addHook({ name: 'graphql', file: 'language/parser.js', versions: ['>=0.10'] }, parser => {

    const conf = this.config

    const startCh = channel('apm:graphql:parser:start')
    const finishCh = channel('apm:graphql:parser:finish')
    const errorCh = channel('apm:graphql:parser:error')

    shimmer.wrap(parser, 'parse', parse => function (source) {
        if (!startCh.hasSubscribers) {
            return parse.apply(this, arguments)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        return asyncResource.runInAsyncScope(() => {
            startCh.publish(undefined)
            let document
            try {
                document = parse.apply(this, arguments)
                const operation = getOperation(document)

                if (!operation) return document

                if (source) {
                    documentSources.set(document, source.body || source)
                }

                return document
            } catch (err) {
                err.stack
                errorCh.publish(err)

                throw err
            } finally {
                finishCh.publish({ source, document, docSource: documentSources.get(document) })
            }
        })
    })
    return parser
})

addHook({ name: 'graphql', file: 'validation/validate.js', versions: ['>=0.10'] }, validate => {

    const startCh = channel('apm:graphql:validate:start')
    const finishCh = channel('apm:graphql:validate:finish')
    const errorCh = channel('apm:graphql:validate:error')

    shimmer.wrap(validate, 'validate', val => function (_schema, document, _rules, _typeInfo) {
        if (!startCh.hasSubscribers) {
            return val.apply(this, arguments)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        asyncResource.runInAsyncScope(() => {
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
    })

    return validate
})