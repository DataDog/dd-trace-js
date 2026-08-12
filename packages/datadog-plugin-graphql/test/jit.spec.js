'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const semifies = require('../../../vendor/dist/semifies')
const { assertObjectContains, sandboxCwd, useSandbox } = require('../../../integration-tests/helpers')
const rewriterInstrumentations = require('../../datadog-instrumentations/src/helpers/rewriter/instrumentations')
const { rewrite } = require('../../datadog-instrumentations/src/helpers/rewriter')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema } = require('./naming')

const generatedCodeLinter = semifies(process.version, require('eslint/package.json').engines.node)
  ? new (require('eslint').ESLint)({ cwd: join(__dirname, '../../..') })
  : undefined

function noop () {}

/**
 * @param {string} compilation
 * @param {string[]} expectedStatements
 * @returns {Promise<void>}
 */
async function assertGeneratedArgumentFactory (compilation, expectedStatements) {
  const declaration = /^function (ddTraceArguments\d+) \(args, variableValues\) \{$/m.exec(compilation)
  assert.ok(declaration, 'expected a named generated argument factory')

  const end = compilation.indexOf('\n}\n', declaration.index)
  assert.notStrictEqual(end, -1, 'expected the generated argument factory to close')
  const factory = compilation.slice(declaration.index, end + 2)
  for (const statement of expectedStatements) assert.ok(factory.includes(statement), statement)
  assert.doesNotMatch(factory, /=>|\(function/)
  assert.ok(compilation.includes(`, ${declaration[1]})`))

  if (generatedCodeLinter === undefined) return

  const source = `'use strict'\n\n${factory}\n${declaration[1]}({}, {})\n`
  const [{ messages }] = await generatedCodeLinter.lintText(source, {
    filePath: join(__dirname, '../src/generated-argument-factory.js'),
  })
  assert.deepStrictEqual(messages, [])
}

/**
 * @template T
 * @param {() => T} execute
 * @param {RegExp} spanResourceMatch
 * @param {(traces: import('../../dd-trace/src/opentracing/span')[][]) => void} [assertTraces]
 * @returns {Promise<Awaited<T>>}
 */
async function executeWithTrace (execute, spanResourceMatch, assertTraces = noop) {
  const [, result] = await Promise.all([
    agent.assertSomeTraces(assertTraces, { spanResourceMatch }),
    (async () => execute())(),
  ])
  return result
}

describe('Plugin', () => {
  describe('graphql-jit', () => {
    let graphql
    let compileQuery
    let schema

    /**
     * @param {unknown} _source
     * @param {{ name?: string }} args
     */
    function resolveHello (_source, { name }) {
      return name || 'world'
    }

    /**
     * @param {unknown} _source
     * @param {{ name?: string }} args
     * @yields {{ greeting: string }} Greeting result.
     */
    async function * subscribeGreetings (_source, { name }) {
      yield { greeting: `${name} one` }
      yield { greeting: `${name} two` }
    }

    function buildSchema () {
      return new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'Query',
          fields: {
            hello: {
              type: graphql.GraphQLString,
              args: { name: { type: graphql.GraphQLString } },
              resolve: resolveHello,
            },
            defaultHello: { type: graphql.GraphQLString },
            slow: { type: graphql.GraphQLString, resolve: () => Promise.resolve('later') },
            boom: {
              type: graphql.GraphQLString,
              resolve: () => { throw new Error('resolver boom') },
            },
          },
        }),
        mutation: new graphql.GraphQLObjectType({
          name: 'Mutation',
          fields: {
            setHello: {
              type: graphql.GraphQLString,
              args: { name: { type: graphql.GraphQLString } },
              resolve: resolveHello,
            },
          },
        }),
        subscription: new graphql.GraphQLObjectType({
          name: 'Subscription',
          fields: {
            greeting: {
              type: graphql.GraphQLString,
              args: { name: { type: graphql.GraphQLString } },
              subscribe: subscribeGreetings,
              resolve: ({ greeting }) => greeting,
            },
          },
        }),
      })
    }

    /**
     * @returns {import('graphql').GraphQLSchema}
     */
    function buildFalsySourceSchema () {
      const FalsySource = new graphql.GraphQLObjectType({
        name: 'FalsySource',
        fields: {
          value: { type: graphql.GraphQLString },
        },
      })

      return new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'FalsySourceQuery',
          fields: {
            zero: {
              type: FalsySource,
              resolve: () => 0,
            },
            falseValue: {
              type: FalsySource,
              resolve: () => false,
            },
            emptyString: {
              type: FalsySource,
              resolve: () => '',
            },
          },
        }),
      })
    }

    /**
     * @param {{ __typename: string }} value
     * @returns {string}
     */
    function resolveType (value) {
      return value.__typename
    }

    /**
     * @returns {import('graphql').GraphQLSchema}
     */
    function buildCoordinateSchema () {
      const Profile = new graphql.GraphQLInterfaceType({
        name: 'Profile',
        fields: {
          value: { type: graphql.GraphQLString },
        },
        resolveType,
      })
      const Named = new graphql.GraphQLInterfaceType({
        name: 'Named',
        fields: {
          profile: { type: Profile },
        },
        resolveType,
      })
      const HumanProfile = new graphql.GraphQLObjectType({
        name: 'HumanProfile',
        interfaces: [Profile],
        fields: {
          value: { type: graphql.GraphQLString },
        },
      })
      const PetProfile = new graphql.GraphQLObjectType({
        name: 'PetProfile',
        interfaces: [Profile],
        fields: {
          value: { type: graphql.GraphQLString },
        },
      })
      const Human = new graphql.GraphQLObjectType({
        name: 'Human',
        interfaces: [Named],
        fields: {
          profile: { type: Profile },
        },
      })
      const Pet = new graphql.GraphQLObjectType({
        name: 'Pet',
        interfaces: [Named],
        fields: {
          profile: { type: Profile },
        },
      })

      return new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'Query',
          fields: {
            results: {
              type: new graphql.GraphQLList(Named),
              resolve: () => [
                {
                  __typename: 'Human',
                  profile: { __typename: 'HumanProfile', value: 'person' },
                },
                {
                  __typename: 'Pet',
                  profile: { __typename: 'PetProfile', value: 'animal' },
                },
              ],
            },
          },
        }),
        types: [Human, Pet, HumanProfile, PetProfile],
      })
    }

    /**
     * @param {import('graphql').ExecutionResult} actual
     * @param {import('graphql').ExecutionResult} expected
     * @param {string} [message]
     */
    function assertSameExecutionResult (actual, expected, message) {
      assert.deepStrictEqual(actual.data, expected.data, message)
      assert.deepStrictEqual(
        actual.errors?.map(error => error.message),
        expected.errors?.map(error => error.message),
        message
      )
    }

    withVersions('graphql', 'graphql-jit', '>=0.7.0', version => {
      const packageRoot = join(__dirname, '../../../versions', `graphql-jit@${version}`, 'node_modules/graphql-jit')

      before(() => {
        return agent.load('graphql', { variables: ['id', 'name'] })
      })

      before(() => {
        const graphqlJit = require(`../../../versions/graphql-jit@${version}`)
        graphql = graphqlJit.get('graphql')
        compileQuery = graphqlJit.get().compileQuery
        schema = buildSchema()
      })

      after(() => {
        return agent.close()
      })

      it('pairs graphql-jit with its declared GraphQL range', () => {
        const { devDependencies, peerDependencies, version: installedVersion } =
          require(join(packageRoot, 'package.json'))
        const graphqlRange = devDependencies?.graphql ?? peerDependencies.graphql

        assert.ok(
          semifies(graphql.version, graphqlRange),
          `graphql@${graphql.version} is outside graphql-jit@${installedVersion}'s declared range`
        )
      })

      it('rewrites every registered module layout', () => {
        const installedVersion = require(join(packageRoot, 'package.json')).version

        const filePaths = new Set()
        for (const { module } of rewriterInstrumentations) {
          if (module.name === 'graphql-jit' && semifies(installedVersion, module.versionRange)) {
            filePaths.add(module.filePath)
          }
        }
        assert.ok(filePaths.size > 0, `no instrumentation registered for graphql-jit@${installedVersion}`)

        for (const filePath of filePaths) {
          const filename = join(packageRoot, filePath)
          const content = readFileSync(filename, 'utf8')
          for (const format of ['commonjs', 'module']) {
            const rewritten = rewrite(content, filename, format)
            assert.notStrictEqual(rewritten, content, `${filePath} was not rewritten as ${format}`)
            assert.match(rewritten, /ddTraceRuntime/, `${filePath} lost the runtime hooks as ${format}`)
          }
        }
      })

      it('emits graphql.execute for a JIT-compiled query', async () => {
        const document = graphql.parse('query GetHello($name: String!) { hello(name: $name) }')
        const { query } = compileQuery(schema, document)

        const result = await executeWithTrace(() => query({}, {}, { name: 'Ada' }), /GetHello/, traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')

          assertObjectContains(execute, {
            service: expectedSchema.server.serviceName,
            name: expectedSchema.server.opName,
            type: 'graphql',
            error: 0,
            meta: {
              'graphql.operation.type': 'query',
              'graphql.operation.name': 'GetHello',
              'graphql.variables.name': 'Ada',
              component: 'graphql',
              '_dd.integration': 'graphql',
            },
          })
          assert.match(execute.resource, /GetHello/)
          assertObjectContains(resolve, {
            name: 'graphql.resolve',
            resource: 'hello:String',
            meta: {
              'graphql.field.name': 'hello',
              'graphql.field.path': 'hello',
              'graphql.field.type': 'String',
            },
          })
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
        })
        assert.deepStrictEqual(result.data, { hello: 'Ada' })
      })

      it('derives anonymous operation metadata', async () => {
        const { query } = compileQuery(schema, graphql.parse('{ hello }'))

        /** @param {import('../../dd-trace/src/opentracing/span')[][]} traces */
        function assertOperation (traces) {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)

          assert.strictEqual(execute.resource, '{hello}')
          assert.strictEqual(execute.meta['graphql.operation.type'], 'query')
          assert.ok(!('graphql.operation.name' in execute.meta))
        }

        const result = await executeWithTrace(() => query({}, {}, {}), /hello:String/, assertOperation)

        assert.deepStrictEqual(result.data, { hello: 'world' })
      })

      it('traces a compiled default field resolver', async () => {
        const { query } = compileQuery(schema, graphql.parse('query DefaultHello { defaultHello }'))

        const result = await executeWithTrace(
          () => query({ defaultHello: 'default world' }, {}, {}),
          /DefaultHello/,
          traces => {
            const resolve = traces[0].find(span => span.name === 'graphql.resolve')
            assertObjectContains(resolve, {
              resource: 'defaultHello:String',
              meta: { 'graphql.field.name': 'defaultHello' },
            })
          }
        )
        assert.deepStrictEqual(result.data, { defaultHello: 'default world' })
      })

      it('preserves getter reads in compiled default field completion', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'GetterUser',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const getterSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'GetterQuery',
            fields: {
              user: { type: User },
            },
          }),
        })
        const document = graphql.parse('query GetterReads { user { value } }')
        let baselineReads = 0
        const baselineSource = {
          user: {
            get value () {
              baselineReads++
              return `value-${baselineReads}`
            },
          },
        }

        agent.reload('graphql', { enabled: false })
        const baseline = compileQuery(getterSchema, document).query(baselineSource, {}, {})

        let tracedReads = 0
        const tracedSource = {
          user: {
            get value () {
              tracedReads++
              return `value-${tracedReads}`
            },
          },
        }

        agent.reload('graphql', { enabled: true })
        try {
          const { query } = compileQuery(getterSchema, document)
          const result = await executeWithTrace(() => query(tracedSource, {}, {}), /GetterReads/)

          assertSameExecutionResult(result, baseline)
          assert.strictEqual(tracedReads, baselineReads)
        } finally {
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
      })

      it('traces nested defaults when the document omits empty argument lists', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'OmittedArgumentsUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const nestedSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'OmittedArgumentsQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada' }),
              },
            },
          }),
        })

        const document = graphql.parse('query OmittedArgumentLists { user { name } }')
        const [nested] = document.definitions[0].selectionSet.selections[0].selectionSet.selections
        delete nested.arguments
        delete nested.directives

        const compiled = compileQuery(nestedSchema, document)
        assert.strictEqual(
          typeof compiled.query,
          'function',
          `Compilation failed: ${compiled.errors?.[0]?.message}`
        )

        const result = await executeWithTrace(() => compiled.query(undefined, {}, {}), /OmittedArgumentLists/, traces => {
          const resolve = traces[0].find(span => span.meta?.['graphql.field.path'] === 'user.name')
          assertObjectContains(resolve, {
            resource: 'name:String',
            meta: { 'graphql.field.name': 'name' },
          })
        })
        assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
      })

      it('preserves top-level promise-valued default completion semantics', async () => {
        for (const testCase of [
          {
            operationName: 'ResolvedDefaultPromise',
            createValue: () => Promise.resolve('async default'),
            expectedUpdate: undefined,
          },
          {
            operationName: 'RejectedDefaultPromise',
            createValue: () => Promise.reject(new Error('default rejection')),
            expectedUpdate: 'default rejection',
          },
        ]) {
          const document = graphql.parse(`query ${testCase.operationName} { defaultHello }`)

          agent.reload('graphql', { enabled: false })
          const baseline = await compileQuery(schema, document)
            .query({ defaultHello: testCase.createValue() }, {}, {})

          agent.reload('graphql', { enabled: true })
          const { query } = compileQuery(schema, document)
          const updates = []
          const updateChannel = dc.channel('apm:graphql:resolve:updateField')
          /** @param {{ error?: Error | null, field: { fieldName: string } }} message */
          const onUpdate = ({ error, field }) => {
            if (field.fieldName === 'defaultHello') updates.push(error?.message)
          }

          updateChannel.subscribe(onUpdate)
          try {
            const result = await executeWithTrace(
              () => query({ defaultHello: testCase.createValue() }, {}, {}),
              new RegExp(testCase.operationName),
              traces => {
                const resolve = traces[0].find(span =>
                  span.name === 'graphql.resolve' && span.resource === 'defaultHello:String')
                assert.ok(resolve, 'expected the promise-valued default resolver span')
              }
            )

            assertSameExecutionResult(result, baseline)
          } finally {
            updateChannel.unsubscribe(onUpdate)
          }

          assert.deepStrictEqual(updates, [testCase.expectedUpdate])
        }
      })

      it('preserves custom thenable results and finishes their spans on settlement', async () => {
        const tracer = require('../../dd-trace')
        let hookCall
        let settled

        /**
         * @param {import('../../dd-trace/src/opentracing/span')} _span
         * @param {{ error?: Error, fieldName: string, result?: unknown }} field
         */
        function resolveHook (_span, field) {
          if (field.fieldName === 'value') {
            hookCall = {
              error: field.error?.message,
              result: field.result,
              settled,
            }
          }
        }

        try {
          for (const testCase of [
            {
              operationName: 'CustomThenableSuccess',
              createThenable: () => ({
                /**
                 * @param {(value: string) => void} resolve
                 * @returns {string}
                 */
                then (resolve) {
                  queueMicrotask(() => {
                    settled = true
                    resolve('actual')
                  })
                  return 'wrong'
                },
              }),
              expectedHook: { error: undefined, result: 'actual', settled: true },
            },
            {
              operationName: 'CustomThenableFailure',
              createThenable: () => ({
                /**
                 * @param {(value: string) => void} _resolve
                 * @param {(error: Error) => void} reject
                 */
                then (_resolve, reject) {
                  queueMicrotask(() => {
                    settled = true
                    reject(new Error('thenable rejection'))
                  })
                },
              }),
              expectedHook: { error: 'thenable rejection', result: undefined, settled: true },
            },
          ]) {
            settled = false
            hookCall = undefined
            const thenableSchema = new graphql.GraphQLSchema({
              query: new graphql.GraphQLObjectType({
                name: `${testCase.operationName}Query`,
                fields: {
                  value: {
                    type: graphql.GraphQLString,
                    resolve: testCase.createThenable,
                  },
                },
              }),
            })
            const document = graphql.parse(`query ${testCase.operationName} { value }`)

            agent.reload('graphql', { enabled: false })
            const baseline = await compileQuery(thenableSchema, document).query({}, {}, {})

            tracer.use('graphql', {
              variables: ['id', 'name'],
              hooks: { resolve: resolveHook },
            })
            const { query } = compileQuery(thenableSchema, document)
            const result = await executeWithTrace(
              () => query({}, {}, {}),
              new RegExp(testCase.operationName),
              traces => {
                const resolve = traces[0].find(span => span.resource === 'value:String')
                assert.strictEqual(resolve.error, testCase.expectedHook.error ? 1 : 0)
              }
            )

            assertSameExecutionResult(result, baseline)
            assert.deepStrictEqual(hookCall, testCase.expectedHook)
          }
        } finally {
          tracer.use('graphql', { variables: ['id', 'name'] })
        }
      })

      it('does not inspect then on nested default field values', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'ThrowingThenUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const throwingThenSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'ThrowingThenQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name }),
              },
            },
          }),
        })
        const name = Object.defineProperty({}, 'then', {
          get () {
            throw new Error('then getter boom')
          },
        })
        const { query } = compileQuery(
          throwingThenSchema,
          graphql.parse('query ThrowingThen { user { name } }')
        )
        const result = await executeWithTrace(() => query({}, {}, {}), /ThrowingThen/, traces => {
          const resolve = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'name:String')
          assert.ok(resolve, 'expected the nested default resolver span')
          assert.strictEqual(resolve.error, 0)
        })
        assert.deepStrictEqual(result.data, { user: { name: null } })
        assert.strictEqual(result.errors.length, 1)
        assert.match(result.errors[0].message, /String cannot represent value/)
      })

      it('preserves promise-valued default completion with directives and arguments', async () => {
        let parseLiteralCalls = 0
        const GuardedInput = new graphql.GraphQLScalarType({
          name: 'GuardedInput',
          serialize: value => value,
          parseValue: value => value,
          /** @param {import('graphql').ValueNode} node */
          parseLiteral (node) {
            parseLiteralCalls++
            return node.value
          },
        })
        const User = new graphql.GraphQLObjectType({
          name: 'GuardedDefaultUser',
          fields: {
            name: { type: graphql.GraphQLString, args: { upper: { type: GuardedInput } } },
          },
        })
        const guardedSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'GuardedDefaultQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: Promise.resolve('Ada') }),
              },
            },
          }),
        })
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const onResolver = () => {}

        resolverStartChannel.subscribe(onResolver)
        try {
          for (const source of [
            'query GuardedDirective { user { name @include(if: true) } }',
            'query GuardedArguments { user { name(upper: true) } }',
          ]) {
            const document = graphql.parse(source)

            agent.reload('graphql', { enabled: false })
            const baseline = await compileQuery(guardedSchema, document).query({}, {}, {})

            agent.reload('graphql', { variables: ['id', 'name'] })
            const { query } = compileQuery(guardedSchema, graphql.parse(source))
            const operationName = document.definitions[0].name.value
            const result = await executeWithTrace(() => query({}, {}, {}), new RegExp(operationName))

            assertSameExecutionResult(result, baseline, source)
          }
        } finally {
          resolverStartChannel.unsubscribe(onResolver)
        }
        assert.strictEqual(parseLiteralCalls, 0)
      })

      it('still finishes JIT spans when completion hooks throw', async () => {
        const tracer = require('../../dd-trace')
        const rejections = []
        /** @param {unknown} reason */
        const onRejection = reason => rejections.push(reason)

        process.on('unhandledRejection', onRejection)
        try {
          for (const testCase of [
            { hook: 'execute', spanName: 'graphql.execute' },
            { hook: 'resolve', spanName: 'graphql.resolve' },
          ]) {
            const operationName = `${testCase.hook}HookThrows`
            tracer.use('graphql', {
              variables: ['id', 'name'],
              hooks: { [testCase.hook]: () => { throw new Error(`${testCase.hook} hook boom`) } },
            })
            const { query } = compileQuery(schema, graphql.parse(`query ${operationName} { slow }`))
            const result = await executeWithTrace(() => query({}, {}, {}), new RegExp(operationName), traces => {
              const span = traces[0].find(span => span.name === testCase.spanName)
              assert.ok(span, `expected ${testCase.spanName} span`)
              assert.strictEqual(span.error, 0)
            })
            assert.deepStrictEqual(result.data, { slow: 'later' })
          }
          await new Promise(resolve => setImmediate(resolve))
        } finally {
          tracer.use('graphql', { variables: ['id', 'name'] })
          process.removeListener('unhandledRejection', onRejection)
        }

        assert.deepStrictEqual(rejections.map(reason => reason?.message), [])
      })

      it('preserves nested promise-valued default fields', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'NestedPromiseUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const promiseSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'NestedPromiseQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: Promise.resolve('Ada') }),
              },
            },
          }),
        })
        const document = graphql.parse('query NestedPromise { user { name } }')

        agent.reload('graphql', { enabled: false })
        const baseline = await compileQuery(promiseSchema, document).query({}, {}, {})

        agent.reload('graphql', { enabled: true })
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const onResolver = () => {}
        resolverStartChannel.subscribe(onResolver)
        try {
          const { query } = compileQuery(promiseSchema, document)
          const result = await executeWithTrace(() => query({}, {}, {}), /NestedPromise/)

          assertSameExecutionResult(result, baseline)
        } finally {
          resolverStartChannel.unsubscribe(onResolver)
        }
      })

      it('finishes nested default spans for promises graphql-jit does not await', async () => {
        const tracer = require('../../dd-trace')
        let hookCalls = 0
        let hookResult
        const User = new graphql.GraphQLObjectType({
          name: 'UnsettledNestedPromiseUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const promiseSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'UnsettledNestedPromiseQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: new Promise(() => {}) }),
              },
            },
          }),
        })
        const document = graphql.parse('query UnsettledNestedPromise { user { name } }')

        agent.reload('graphql', { enabled: false })
        const baseline = await compileQuery(promiseSchema, document).query({}, {}, {})

        tracer.use('graphql', {
          hooks: {
            resolve (_span, field) {
              if (field.fieldName === 'name') {
                hookCalls++
                hookResult = field.result
              }
            },
          },
        })
        let result
        try {
          const { query } = compileQuery(promiseSchema, document)
          ;[, result] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const resolve = traces[0].find(span =>
                span.name === 'graphql.resolve' && span.resource === 'name:String')
              assert.ok(resolve, 'expected the nested default resolver span')
            }, { spanResourceMatch: /UnsettledNestedPromise/ }),
            query({}, {}, {}),
          ])
        } finally {
          tracer.use('graphql', { variables: ['id', 'name'] })
        }

        assertSameExecutionResult(result, baseline)
        assert.strictEqual(hookCalls, 1)
        assert.strictEqual(hookResult, undefined)
      })

      it('tags errors thrown by a default field getter', async () => {
        const { query } = compileQuery(schema, graphql.parse('query DefaultGetterError { defaultHello }'))
        const rootValue = Object.defineProperty({}, 'defaultHello', {
          get () {
            throw new Error('default getter boom')
          },
        })
        const result = await executeWithTrace(() => query(rootValue, {}, {}), /DefaultGetterError/, traces => {
          const resolve = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'defaultHello:String')
          assert.ok(resolve, 'expected the throwing default resolver span')
          assert.strictEqual(resolve.error, 1)
        })
        assert.strictEqual(result.errors.length, 1)
        assert.strictEqual(result.errors[0].message, 'default getter boom')
      })

      it('keeps collapsed abstract fields distinct and correctly parented by schema coordinate', async () => {
        const { query } = compileQuery(
          buildCoordinateSchema(),
          graphql.parse('query Coordinates { results { profile { value } } }')
        )

        const result = await executeWithTrace(() => query({}, {}, {}), /Coordinates/, traces => {
          const spans = traces[0].filter(span => span.name === 'graphql.resolve')
          const coordinates = spans.map(span => span.meta['graphql.field.coordinates']).sort()
          assert.deepStrictEqual(coordinates, [
            'Human.profile',
            'HumanProfile.value',
            'Pet.profile',
            'PetProfile.value',
            'Query.results',
          ])

          for (const name of ['Human', 'Pet']) {
            const profile = spans.find(span => span.meta['graphql.field.coordinates'] === `${name}.profile`)
            const value = spans.find(span => span.meta['graphql.field.coordinates'] === `${name}Profile.value`)
            assert.strictEqual(value.parent_id.toString(), profile.span_id.toString())
          }
        })
        assert.deepStrictEqual(result.data, {
          results: [
            { profile: { value: 'person' } },
            { profile: { value: 'animal' } },
          ],
        })
      })

      it('reuses collapsed explicit resolver fields across list items', async () => {
        const Leaf = new graphql.GraphQLObjectType({
          name: 'CollapsedExplicitLeaf',
          fields: {
            value: {
              type: graphql.GraphQLString,
              resolve: source => source.value,
            },
          },
        })
        const Item = new graphql.GraphQLObjectType({
          name: 'CollapsedExplicitItem',
          fields: {
            leaf: {
              type: Leaf,
              resolve: source => source.leaf,
            },
          },
        })
        const explicitSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'CollapsedExplicitQuery',
            fields: {
              items: {
                type: new graphql.GraphQLList(Item),
                resolve: () => [
                  { leaf: { value: 'one' } },
                  { leaf: { value: 'two' } },
                ],
              },
            },
          }),
        })
        const { query } = compileQuery(
          explicitSchema,
          graphql.parse('query CollapsedExplicit { items { leaf { value } } }')
        )

        const firstResult = await executeWithTrace(() => query({}, {}, {}), /CollapsedExplicit/)
        assert.deepStrictEqual(firstResult.data, {
          items: [
            { leaf: { value: 'one' } },
            { leaf: { value: 'two' } },
          ],
        })

        const updateChannel = dc.channel('apm:graphql:resolve:updateField')
        const updateCalls = new Map()
        /** @param {{ field: { fieldName: string } }} message */
        const onUpdate = ({ field }) => {
          updateCalls.set(field.fieldName, (updateCalls.get(field.fieldName) ?? 0) + 1)
        }

        updateChannel.subscribe(onUpdate)
        try {
          const result = await executeWithTrace(() => query({}, {}, {}), /CollapsedExplicit/, traces => {
            const spans = traces[0].filter(span => span.name === 'graphql.resolve')
            const items = spans.find(span => span.meta['graphql.field.name'] === 'items')
            const leaf = spans.find(span => span.meta['graphql.field.name'] === 'leaf')
            const value = spans.find(span => span.meta['graphql.field.name'] === 'value')
            assert.ok(items, 'expected items span')
            assert.ok(leaf, 'expected collapsed leaf span')
            assert.ok(value, 'expected collapsed value span')
            assert.strictEqual(leaf.parent_id.toString(), items.span_id.toString())
            assert.strictEqual(value.parent_id.toString(), leaf.span_id.toString())
          })
          assert.deepStrictEqual(result.data, firstResult.data)
        } finally {
          updateChannel.unsubscribe(onUpdate)
        }

        assert.strictEqual(updateCalls.get('items'), 1)
        assert.strictEqual(updateCalls.get('leaf'), 2)
        assert.strictEqual(updateCalls.get('value'), 2)
      })

      it('keeps uncollapsed list fields distinct and correctly parented', async () => {
        const Profile = new graphql.GraphQLObjectType({
          name: 'UncollapsedProfile',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const Item = new graphql.GraphQLObjectType({
          name: 'UncollapsedItem',
          fields: {
            profile: { type: Profile },
            explicitProfile: {
              type: Profile,
              resolve: source => source.profile,
            },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'UncollapsedQuery',
            fields: {
              items: {
                type: new graphql.GraphQLList(Item),
                resolve: () => [
                  { profile: { value: 'one' } },
                  { profile: { value: 'two' } },
                  { profile: { value: 'three' } },
                ],
              },
            },
          }),
        })

        agent.reload('graphql', { collapse: false })
        try {
          const { query } = compileQuery(
            listSchema,
            graphql.parse('query Uncollapsed { items { profile { value } explicitProfile { value } } }')
          )
          const result = await executeWithTrace(() => query({}, {}, {}), /Uncollapsed/, traces => {
            const spans = traces[0].filter(span => span.name === 'graphql.resolve')
            const items = spans.find(span => span.meta['graphql.field.path'] === 'items')
            assert.ok(items, 'expected items span')
            for (let i = 0; i < 3; i++) {
              const profile = spans.find(span => span.meta['graphql.field.path'] === `items.${i}.profile`)
              const value = spans.find(span => span.meta['graphql.field.path'] === `items.${i}.profile.value`)
              const explicitProfile = spans.find(
                span => span.meta['graphql.field.path'] === `items.${i}.explicitProfile`
              )
              const explicitValue = spans.find(
                span => span.meta['graphql.field.path'] === `items.${i}.explicitProfile.value`
              )
              assert.ok(profile, `expected items.${i}.profile span`)
              assert.ok(value, `expected items.${i}.profile.value span`)
              assert.ok(explicitProfile, `expected items.${i}.explicitProfile span`)
              assert.ok(explicitValue, `expected items.${i}.explicitProfile.value span`)
              assert.strictEqual(profile.parent_id.toString(), items.span_id.toString())
              assert.strictEqual(value.parent_id.toString(), profile.span_id.toString())
              assert.strictEqual(explicitProfile.parent_id.toString(), items.span_id.toString())
              assert.strictEqual(explicitValue.parent_id.toString(), explicitProfile.span_id.toString())
            }
          })
          assert.deepStrictEqual(result.data, {
            items: [
              { profile: { value: 'one' }, explicitProfile: { value: 'one' } },
              { profile: { value: 'two' }, explicitProfile: { value: 'two' } },
              { profile: { value: 'three' }, explicitProfile: { value: 'three' } },
            ],
          })
        } finally {
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
      })

      it('keeps compiler failures isolated from later compilations', async () => {
        const document = graphql.parse('query KnownOperation { hello }')
        const failed = compileQuery(schema, document, 'MissingOperation')
        assert.strictEqual(Array.isArray(failed.errors), true)
        assert.strictEqual(failed.errors.length, 1)

        const { query } = compileQuery(schema, document)
        const result = await executeWithTrace(() => query({}, {}, {}), /KnownOperation/, traces => {
          assert.ok(traces[0].some(span => span.name === expectedSchema.server.opName))
          assert.ok(traces[0].some(span => span.name === 'graphql.resolve'))
        })
        assert.deepStrictEqual(result.data, { hello: 'world' })
      })

      it('preserves a configured resolver info enricher', async () => {
        const enrichedValues = []
        let enrichmentReads = 0
        const enrichedInfo = {
          __datadogGraphqlJitField: 'preserved',
          dynamic: 'first',
          get enriched () {
            enrichmentReads++
            return `${this.dynamic}-${enrichmentReads}`
          },
        }
        const enrichedSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'EnrichedQuery',
            fields: {
              value: {
                type: graphql.GraphQLString,
                /**
                 * @param {unknown} _source
                 * @param {object} _args
                 * @param {unknown} _context
                 * @param {{ __datadogGraphqlJitField?: unknown, dynamic?: string, enriched?: string }} info
                 * @returns {string}
                 */
                resolve (_source, _args, _context, info) {
                  enrichedValues.push({
                    argumentCount: arguments.length,
                    collision: info.__datadogGraphqlJitField === 'preserved',
                    dynamic: info.dynamic,
                    value: info.enriched,
                  })
                  return 'value'
                },
              },
            },
          }),
        })
        const { query } = compileQuery(
          enrichedSchema,
          graphql.parse('query Enriched { value }'),
          undefined,
          {
            resolverInfoEnricher: () => enrichedInfo,
          }
        )

        for (let execution = 0; execution < 2; execution++) {
          if (execution === 1) enrichedInfo.dynamic = 'second'
          const result = await executeWithTrace(() => query({}, {}, {}), /Enriched/)
          assert.deepStrictEqual(result.data, { value: 'value' })
        }
        assert.deepStrictEqual(enrichedValues, [
          { argumentCount: 4, collision: true, dynamic: 'first', value: 'first-1' },
          { argumentCount: 4, collision: true, dynamic: 'second', value: 'second-2' },
        ])
        assert.strictEqual(enrichedInfo.__datadogGraphqlJitField, 'preserved')
        assert.strictEqual(enrichmentReads, 2)
      })

      it('traces nested default field resolvers and publishes their resolver channels', async () => {
        let queryTypeChecks = 0
        let userTypeChecks = 0
        const User = new graphql.GraphQLObjectType({
          name: 'NestedDefaultUser',
          isTypeOf: () => {
            userTypeChecks++
            return true
          },
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const nestedSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'NestedDefaultQuery',
            isTypeOf: () => {
              queryTypeChecks++
              return false
            },
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada' }),
              },
            },
          }),
        })
        const resolveStartChannel = dc.channel('apm:graphql:resolve:start')
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const resolveStartFields = []
        const resolverStartFields = []
        /** @param {{ info: { fieldName: string } }} message */
        const onResolveStart = ({ info }) => resolveStartFields.push(info.fieldName)
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onResolverStart = ({ resolverInfo }) => resolverStartFields.push(...Object.keys(resolverInfo))

        resolveStartChannel.subscribe(onResolveStart)
        resolverStartChannel.subscribe(onResolverStart)
        try {
          const { query } = compileQuery(
            nestedSchema,
            graphql.parse('query NestedDefault { user { name } }')
          )
          const result = await executeWithTrace(() => query({}, {}, {}), /NestedDefault/, traces => {
            const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
            const user = traces[0].find(span =>
              span.name === 'graphql.resolve' && span.resource === 'user:NestedDefaultUser')
            const name = traces[0].find(span => span.name === 'graphql.resolve' && span.resource === 'name:String')
            assert.ok(execute, 'expected a NestedDefault execute span')
            assert.ok(user, 'expected an explicit user resolver span')
            assert.ok(name, 'expected a nested default resolver span')
            assert.strictEqual(user.parent_id.toString(), execute.span_id.toString())
            assert.strictEqual(name.parent_id.toString(), user.span_id.toString())
          })
          assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
        } finally {
          resolveStartChannel.unsubscribe(onResolveStart)
          resolverStartChannel.unsubscribe(onResolverStart)
        }

        assert.deepStrictEqual(resolveStartFields.sort(), ['name', 'user'])
        assert.deepStrictEqual(resolverStartFields.sort(), ['name', 'user'])
        assert.strictEqual(queryTypeChecks, 0)
        assert.strictEqual(userTypeChecks, 1)
      })

      it('preserves nested isTypeOf rejection while deferring default resolvers', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'RejectedNestedUser',
          isTypeOf: () => false,
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const rejectedSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'RejectedNestedQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada' }),
              },
            },
          }),
        })
        const { query } = compileQuery(
          rejectedSchema,
          graphql.parse('query NestedTypeFailure { user { name } }')
        )

        const result = await executeWithTrace(() => query({}, {}, {}), /NestedTypeFailure/, traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.strictEqual(execute.error, 1)
        })
        assert.deepStrictEqual(result.data, { user: null })
        assert.strictEqual(result.errors.length, 1)
        assert.match(result.errors[0].message, /Expected value of type "RejectedNestedUser"/)
      })

      it('preserves falsy nested sources while deferring default resolvers', async () => {
        const { query } = compileQuery(
          buildFalsySourceSchema(),
          graphql.parse('query FalsySources { zero { value } falseValue { value } emptyString { value } }')
        )

        const result = await executeWithTrace(() => query({}, {}, {}), /FalsySources/, traces => {
          const valueSpans = traces[0].filter(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.strictEqual(valueSpans.length, 3)
        })
        assert.deepStrictEqual(result.data, {
          zero: { value: null },
          falseValue: { value: null },
          emptyString: { value: null },
        })
      })

      it('traces every execution of a compiled query, not only the first', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Repeat { hello }'))

        for (let run = 0; run < 2; run++) {
          await executeWithTrace(() => query({}, {}, {}), /Repeat/, traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
            assert.strictEqual(traces[0][0].meta['graphql.operation.name'], 'Repeat')
          })
        }
      })

      it('traces a promise-returning execution', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Slow { slow }'))

        const result = await executeWithTrace(() => query({}, {}, {}), /Slow/, traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 0,
            meta: { 'graphql.operation.type': 'query', 'graphql.operation.name': 'Slow' },
          })
        })
        assert.deepStrictEqual(result.data, { slow: 'later' })
      })

      it('traces a mutation execution', async () => {
        const document = graphql.parse('mutation SetHello($name: String!) { setHello(name: $name) }')
        const { query } = compileQuery(schema, document)

        const result = await executeWithTrace(() => query({}, {}, { name: 'changed' }), /SetHello/, traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')

          assertObjectContains(execute, {
            error: 0,
            meta: {
              'graphql.operation.type': 'mutation',
              'graphql.operation.name': 'SetHello',
            },
          })
          assertObjectContains(resolve, {
            resource: 'setHello:String',
            meta: { 'graphql.field.path': 'setHello' },
          })
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
        })
        assert.deepStrictEqual(result.data, { setHello: 'changed' })
      })

      it('traces every subscription payload execution', async () => {
        const document = graphql.parse(
          'subscription Greetings($name: String!) { greeting(name: $name) }'
        )
        const { subscribe } = compileQuery(schema, document)
        const stream = await subscribe({}, {}, { name: 'hello' })

        for (const suffix of ['one', 'two']) {
          const payload = await executeWithTrace(() => stream.next(), /Greetings/, traces => {
            const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
            const resolve = traces[0].find(span => span.name === 'graphql.resolve')

            assertObjectContains(execute, {
              error: 0,
              meta: {
                'graphql.operation.type': 'subscription',
                'graphql.operation.name': 'Greetings',
              },
            })
            assertObjectContains(resolve, {
              resource: 'greeting:String',
              meta: { 'graphql.field.path': 'greeting' },
            })
            assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
          })
          assert.deepStrictEqual(payload, {
            value: { data: { greeting: `hello ${suffix}` } },
            done: false,
          })
        }

        assert.deepStrictEqual(await stream.next(), { value: undefined, done: true })
      })

      it('publishes resolver channels once per JIT resolver', async () => {
        const document = graphql.parse('query ResolverChannels { hello defaultHello }')
        const { query } = compileQuery(schema, document)
        const resolveStartChannel = dc.channel('apm:graphql:resolve:start')
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const resolveStartFields = []
        const resolverStartFields = []
        /** @param {{ info: { fieldName: string } }} message */
        const onResolveStart = ({ info }) => resolveStartFields.push(info.fieldName)
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onResolverStart = ({ resolverInfo }) => resolverStartFields.push(...Object.keys(resolverInfo))

        resolveStartChannel.subscribe(onResolveStart)
        resolverStartChannel.subscribe(onResolverStart)
        try {
          const result = await executeWithTrace(
            () => query({ defaultHello: 'default' }, {}, {}),
            /ResolverChannels/,
            traces => {
              assert.strictEqual(
                traces[0].filter(span => span.name === 'graphql.resolve').length,
                2
              )
            }
          )
          assert.deepStrictEqual(result.data, { hello: 'world', defaultHello: 'default' })
        } finally {
          resolveStartChannel.unsubscribe(onResolveStart)
          resolverStartChannel.unsubscribe(onResolverStart)
        }

        assert.deepStrictEqual(resolveStartFields.sort(), ['defaultHello', 'hello'])
        assert.deepStrictEqual(resolverStartFields.sort(), ['defaultHello', 'hello'])
      })

      it('skips resolver spans when depth is zero', async () => {
        const updateChannel = dc.channel('apm:graphql:resolve:updateField')
        let updateCalls = 0
        const onUpdate = () => {
          updateCalls++
        }

        agent.reload('graphql', { depth: 0 })
        updateChannel.subscribe(onUpdate)
        try {
          const { query } = compileQuery(
            schema,
            graphql.parse('query DepthDisabledWithoutSubscribers { hello defaultHello }')
          )
          const result = await executeWithTrace(
            () => query({ defaultHello: 'default' }, {}, {}),
            /DepthDisabledWithoutSubscribers/,
            traces => {
              assert.strictEqual(
                traces[0].filter(span => span.name === 'graphql.resolve').length,
                0
              )
            }
          )
          assert.deepStrictEqual(result.data, { hello: 'world', defaultHello: 'default' })
        } finally {
          updateChannel.unsubscribe(onUpdate)
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
        assert.strictEqual(updateCalls, 0)
      })

      it('tags the field source on collapsed JIT resolvers', async () => {
        agent.reload('graphql', { source: true, variables: ['id', 'name'] })
        try {
          const { query } = compileQuery(schema, graphql.parse('query SourceTagged { hello }'))
          const result = await executeWithTrace(
            () => query({}, {}, {}),
            /SourceTagged/,
            traces => {
              const resolve = traces[0].find(span => span.name === 'graphql.resolve')
              assert.ok(resolve, 'expected a graphql.resolve span')
              assertObjectContains(resolve.meta, {
                'graphql.field.coordinates': 'Query.hello',
                'graphql.field.path': 'hello',
                'graphql.source': 'hello',
              })
            }
          )
          assert.deepStrictEqual(result.data, { hello: 'world' })
        } finally {
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
      })

      it('skips inline defaults beyond a positive resolver depth', async () => {
        const LimitedDepthChild = new graphql.GraphQLObjectType({
          name: 'LimitedDepthChild',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const limitedDepthSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'LimitedDepthQuery',
            fields: {
              child: {
                type: LimitedDepthChild,
                resolve: () => ({ value: 'nested' }),
              },
            },
          }),
        })

        agent.reload('graphql', { depth: 1 })
        try {
          const { query } = compileQuery(
            limitedDepthSchema,
            graphql.parse('query LimitedDepth { child { value } }')
          )
          const result = await executeWithTrace(() => query({}, {}, {}), /LimitedDepth/, traces => {
            const resolveSpans = traces[0].filter(span => span.name === 'graphql.resolve')
            assert.strictEqual(resolveSpans.length, 1)
            assert.strictEqual(resolveSpans[0].resource, 'child:LimitedDepthChild')
          })
          assert.deepStrictEqual(result.data, { child: { value: 'nested' } })
        } finally {
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
      })

      it('counts list indices for JIT depth on the v5 configuration path', async () => {
        const DepthListItem = new graphql.GraphQLObjectType({
          name: 'DepthListItem',
          fields: {
            explicit: {
              type: graphql.GraphQLString,
              resolve: source => source.explicit,
            },
            inline: { type: graphql.GraphQLString },
          },
        })
        const depthListSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'DepthListQuery',
            fields: {
              items: {
                type: new graphql.GraphQLList(DepthListItem),
                resolve: () => [{ explicit: 'resolved', inline: 'default' }],
              },
            },
          }),
        })

        agent.reload('graphql', {
          depth: 2,
          jit: { countListIndices: true },
        })
        try {
          const { query } = compileQuery(
            depthListSchema,
            graphql.parse('query ListIndexDepth { items { explicit inline } }')
          )
          const result = await executeWithTrace(() => query({}, {}, {}), /ListIndexDepth/, traces => {
            const resolveSpans = traces[0].filter(span => span.name === 'graphql.resolve')
            assert.strictEqual(resolveSpans.length, 1)
            assert.strictEqual(resolveSpans[0].resource, 'items:[DepthListItem]')
          })
          assert.deepStrictEqual(result.data, {
            items: [{ explicit: 'resolved', inline: 'default' }],
          })
        } finally {
          agent.reload('graphql', { variables: ['id', 'name'] })
        }
      })

      it('keeps AppSec and IAST resolver events when depth disables resolver spans', async () => {
        const resolveStartChannel = dc.channel('apm:graphql:resolve:start')
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const resolveStartFields = []
        const resolverStartFields = []
        /** @param {{ info: { fieldName: string } }} message */
        const onResolveStart = ({ info }) => resolveStartFields.push(info.fieldName)
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onResolverStart = ({ resolverInfo }) => resolverStartFields.push(...Object.keys(resolverInfo))

        agent.reload('graphql', { depth: 0 })
        resolveStartChannel.subscribe(onResolveStart)
        resolverStartChannel.subscribe(onResolverStart)
        try {
          const { query } = compileQuery(
            schema,
            graphql.parse('query DepthDisabled { hello defaultHello }')
          )
          const result = await executeWithTrace(
            () => query({ defaultHello: 'default' }, {}, {}),
            /DepthDisabled/,
            traces => {
              assert.strictEqual(
                traces[0].filter(span => span.name === 'graphql.resolve').length,
                0
              )
            }
          )
          assert.deepStrictEqual(result.data, { hello: 'world', defaultHello: 'default' })
        } finally {
          resolveStartChannel.unsubscribe(onResolveStart)
          resolverStartChannel.unsubscribe(onResolverStart)
          agent.reload('graphql', { variables: ['id', 'name'] })
        }

        assert.deepStrictEqual(resolveStartFields.sort(), ['defaultHello', 'hello'])
        assert.deepStrictEqual(resolverStartFields.sort(), ['defaultHello', 'hello'])
      })

      it('aborts explicit and inline default resolvers from the resolver start channel', async () => {
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')

        for (const fieldName of ['hello', 'defaultHello']) {
          const { query } = compileQuery(
            schema,
            graphql.parse(`query ResolverBlocked { ${fieldName} }`)
          )
          /** @param {{ abortController: AbortController, resolverInfo: Record<string, unknown> }} message */
          const onResolverStart = ({ abortController, resolverInfo }) => {
            if (resolverInfo[fieldName]) abortController.abort()
          }

          resolverStartChannel.subscribe(onResolverStart)
          try {
            const result = await executeWithTrace(
              () => query({ defaultHello: 'default' }, {}, {}),
              /ResolverBlocked/,
              traces => {
                const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
                assert.strictEqual(execute.error, 1)
              }
            )
            assert.strictEqual(result.errors.length, 1)
            assert.strictEqual(result.errors[0].originalError?.name, 'AbortError')
          } finally {
            resolverStartChannel.unsubscribe(onResolverStart)
          }
        }
      })

      it('publishes resolver channels for every collapsed list invocation', async () => {
        const Speed = new graphql.GraphQLEnumType({
          name: 'ResolverListSpeed',
          values: { FAST: {}, SLOW: {} },
        })
        const Filter = new graphql.GraphQLInputObjectType({
          name: 'ResolverListFilter',
          fields: {
            name: { type: graphql.GraphQLString },
            size: { type: graphql.GraphQLInt },
            exact: { type: graphql.GraphQLBoolean },
          },
        })
        const Item = new graphql.GraphQLObjectType({
          name: 'ResolverListItem',
          fields: {
            value: {
              type: graphql.GraphQLString,
              args: {
                text: { type: graphql.GraphQLString, defaultValue: 'text-default' },
                flag: { type: graphql.GraphQLBoolean, defaultValue: true },
                count: { type: graphql.GraphQLInt, defaultValue: 42 },
                nullable: { type: graphql.GraphQLString, defaultValue: 'nullable-default' },
                missing: { type: graphql.GraphQLString },
                ratio: { type: graphql.GraphQLFloat },
                kind: { type: Speed },
                tags: { type: new graphql.GraphQLList(graphql.GraphQLString) },
                fixedTags: { type: new graphql.GraphQLList(graphql.GraphQLString) },
                filter: { type: Filter },
                fixedFilter: { type: Filter },
                empty: { type: graphql.GraphQLString },
              },
            },
            plain: {
              type: graphql.GraphQLString,
            },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'ResolverListQuery',
            fields: {
              items: {
                type: new graphql.GraphQLList(Item),
                resolve: () => [
                  { value: 'one', plain: 'one' },
                  { value: 'two', plain: 'two' },
                  { value: 'three', plain: 'three' },
                ],
              },
            },
          }),
        })
        const { query } = compileQuery(
          listSchema,
          graphql.parse(`
            query ResolverList(
              $text: String,
              $flag: Boolean,
              $count: Int,
              $nullable: String,
              $missing: String
            ) {
              items {
                value(
                  text: $text
                  flag: $flag
                  count: $count
                  nullable: $nullable
                  missing: $missing
                  ratio: 1.5
                  kind: FAST
                  tags: ["a", $text]
                  fixedTags: ["fixed"]
                  filter: { name: $text, size: 7, exact: true }
                  fixedFilter: { name: "fixed", size: 8, exact: false }
                  empty: null
                )
                plain
              }
            }
          `)
        )
        const resolveStartChannel = dc.channel('apm:graphql:resolve:start')
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const updateChannel = dc.channel('apm:graphql:resolve:updateField')
        const resolveArguments = new Map([['plain', new Set()], ['value', new Set()]])
        const resolverArguments = []
        const resolverStartCalls = new Map()
        const updateCalls = new Map()
        const expectedData = {
          items: [
            { value: 'one', plain: 'one' },
            { value: 'two', plain: 'two' },
            { value: 'three', plain: 'three' },
          ],
        }
        /** @param {Record<string, unknown>} expected */
        function assertResolverArguments (expected) {
          assert.strictEqual(resolverArguments.length, 3)
          for (const actual of resolverArguments) assert.deepStrictEqual(actual, expected)
        }
        /** @param {{ args: object, info: { fieldName: string } }} message */
        const onResolveStart = ({ args, info }) => {
          resolveArguments.get(info.fieldName)?.add(args)
        }
        /** @param {{ resolverInfo: Record<string, Record<string, unknown>> }} message */
        const onResolverStart = ({ resolverInfo }) => {
          const [fieldName] = Object.keys(resolverInfo)
          resolverStartCalls.set(fieldName, (resolverStartCalls.get(fieldName) ?? 0) + 1)
          if (resolverInfo.value) resolverArguments.push(resolverInfo.value)
        }
        /** @param {{ field: { fieldName: string } }} message */
        const onUpdate = ({ field }) => {
          updateCalls.set(field.fieldName, (updateCalls.get(field.fieldName) ?? 0) + 1)
        }

        resolveStartChannel.subscribe(onResolveStart)
        resolverStartChannel.subscribe(onResolverStart)
        try {
          const resultWithoutUpdates = await executeWithTrace(() => query({}, {}, {}), /ResolverList/)
          assert.deepStrictEqual(resultWithoutUpdates.data, expectedData)
          assert.strictEqual(resolveArguments.get('plain').size, 3)
          assert.strictEqual(resolveArguments.get('value').size, 3)
          assert.strictEqual(resolverStartCalls.get('plain'), 3)
          assert.strictEqual(resolverStartCalls.get('value'), 3)
          assertResolverArguments({
            count: 42,
            empty: null,
            filter: { name: undefined, size: 7, exact: true },
            flag: true,
            fixedFilter: { name: 'fixed', size: 8, exact: false },
            fixedTags: ['fixed'],
            kind: 'FAST',
            nullable: 'nullable-default',
            ratio: 1.5,
            tags: ['a', undefined],
            text: 'text-default',
          })
          assert.strictEqual(updateCalls.size, 0)

          for (const args of resolveArguments.values()) args.clear()
          resolverArguments.length = 0
          resolverStartCalls.clear()
          updateChannel.subscribe(onUpdate)

          const result = await executeWithTrace(
            () => query({}, {}, {
              count: 0,
              flag: false,
              nullable: null,
              text: '',
            }),
            /ResolverList/,
            traces => {
              const valueSpans = traces[0].filter(span => span.name === 'graphql.resolve' &&
                (span.resource === 'value:String' || span.resource === 'plain:String'))
              assert.strictEqual(valueSpans.length, 2)
            }
          )
          assert.deepStrictEqual(result.data, expectedData)
        } finally {
          resolveStartChannel.unsubscribe(onResolveStart)
          resolverStartChannel.unsubscribe(onResolverStart)
          updateChannel.unsubscribe(onUpdate)
        }

        assert.strictEqual(resolveArguments.get('plain').size, 3)
        assert.strictEqual(resolveArguments.get('value').size, 3)
        assert.strictEqual(resolverStartCalls.get('plain'), 3)
        assert.strictEqual(resolverStartCalls.get('value'), 3)
        assertResolverArguments({
          count: 0,
          empty: null,
          filter: { name: '', size: 7, exact: true },
          flag: false,
          fixedFilter: { name: 'fixed', size: 8, exact: false },
          fixedTags: ['fixed'],
          kind: 'FAST',
          nullable: null,
          ratio: 1.5,
          tags: ['a', ''],
          text: '',
        })
        assert.strictEqual(updateCalls.get('plain'), 3)
        assert.strictEqual(updateCalls.get('value'), 3)
      })

      it('publishes coerced arguments for inline default resolvers', async () => {
        const Item = new graphql.GraphQLObjectType({
          name: 'CoercedArgumentItem',
          fields: {
            value: {
              type: graphql.GraphQLString,
              args: { identifier: { type: graphql.GraphQLID, defaultValue: 'field-default' } },
            },
          },
        })
        const argumentSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'CoercedArgumentQuery',
            fields: {
              items: {
                type: new graphql.GraphQLList(Item),
                resolve: () => [{ value: 'ok' }],
              },
            },
          }),
        })
        const { query } = compileQuery(
          argumentSchema,
          graphql.parse(`
            query CoercedArguments($identifier: ID = "operation-default") {
              items { value(identifier: $identifier) }
            }
          `)
        )
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        const resolverArguments = []
        /** @param {{ resolverInfo: { value?: { identifier: unknown } } }} message */
        const onResolverStart = ({ resolverInfo }) => {
          if (resolverInfo.value) resolverArguments.push(resolverInfo.value.identifier)
        }

        resolverStartChannel.subscribe(onResolverStart)
        try {
          const defaultResult = await executeWithTrace(() => query({}, {}, {}), /CoercedArguments/)
          assert.deepStrictEqual(defaultResult.data, { items: [{ value: 'ok' }] })

          const variableValues = Object.freeze(Object.defineProperty({}, 'identifier', {
            enumerable: true,
            get () {
              return 123
            },
          }))
          const providedResult = await executeWithTrace(
            () => query({}, {}, variableValues),
            /CoercedArguments/
          )
          assert.deepStrictEqual(providedResult.data, { items: [{ value: 'ok' }] })
        } finally {
          resolverStartChannel.unsubscribe(onResolverStart)
        }

        assert.deepStrictEqual(resolverArguments, ['operation-default', '123'])
      })

      it('shares frozen defaults unless a subscriber may mutate them', async () => {
        const opaqueObjectDefault = Object.freeze({ kind: 'opaque' })
        const schemaFilterDefault = Object.freeze({ extra: 'preserved', name: 'schema' })
        const schemaTagsDefault = Object.freeze(['schema'])
        const literalSchema = graphql.buildSchema(`
          scalar FreshLiteralOpaque
          input FreshLiteralFilter { name: String }
          type FreshLiteralItem {
            value(
              filter: FreshLiteralFilter
              opaqueObject: FreshLiteralOpaque
              schemaFilter: FreshLiteralFilter!
              schemaTags: [String]
              tags: [String]
            ): String
          }
          type Query { items: [FreshLiteralItem] }
        `)
        const valueField = literalSchema.getType('FreshLiteralItem').getFields().value
        const argumentsByName = new Map(valueField.args.map(argument => [argument.name, argument]))
        argumentsByName.get('opaqueObject').defaultValue = opaqueObjectDefault
        argumentsByName.get('schemaFilter').defaultValue = schemaFilterDefault
        argumentsByName.get('schemaTags').defaultValue = schemaTagsDefault
        const { query } = compileQuery(
          literalSchema,
          graphql.parse(
            'query FreshLiteralArguments { items { value(filter: { name: "fresh" }, tags: ["fresh"]) } }'
          )
        )
        const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
        let sharedArguments
        /** @param {{ resolverInfo: { value?: Record<string, unknown> } }} message */
        const onResolverStart = ({ resolverInfo }) => {
          if (resolverInfo.value) sharedArguments = resolverInfo.value
        }

        resolverStartChannel.subscribe(onResolverStart)
        try {
          const result = await executeWithTrace(
            () => query(Object.freeze({
              items: Object.freeze([Object.freeze({ value: 'ok' })]),
            }), Object.freeze({}), Object.freeze({})),
            /FreshLiteralArguments/
          )
          assert.deepStrictEqual(result.data, { items: [{ value: 'ok' }] })
        } finally {
          resolverStartChannel.unsubscribe(onResolverStart)
        }

        assert.ok(sharedArguments)
        assert.strictEqual(sharedArguments.opaqueObject, opaqueObjectDefault)
        assert.strictEqual(sharedArguments.schemaFilter, schemaFilterDefault)
        assert.strictEqual(sharedArguments.schemaTags, schemaTagsDefault)

        const resolveStartChannel = dc.channel('apm:graphql:resolve:start')
        const resolverArguments = []
        /**
         * @param {{
         *   args: {
         *     filter: { name: string },
         *     opaqueObject: { kind: string },
         *     schemaFilter: { extra: string, name: string },
         *     schemaTags: string[],
         *     tags: string[]
         *   },
         *   info: { fieldName: string }
         * }} message
         */
        const onResolveStart = ({ args, info }) => {
          if (info.fieldName !== 'value') return

          resolverArguments.push(args)
          if (resolverArguments.length === 1) {
            args.filter.name = 'mutated'
            args.schemaFilter.name = 'mutated'
            args.schemaTags[0] = 'mutated'
            args.tags[0] = 'mutated'
          }
        }

        resolveStartChannel.subscribe(onResolveStart)
        try {
          for (let execution = 0; execution < 2; execution++) {
            const result = await executeWithTrace(
              () => query({ items: [{ value: 'ok' }] }, {}, {}),
              /FreshLiteralArguments/
            )
            assert.deepStrictEqual(result.data, { items: [{ value: 'ok' }] })
          }
        } finally {
          resolveStartChannel.unsubscribe(onResolveStart)
        }

        assert.deepStrictEqual(resolverArguments[1], {
          filter: { name: 'fresh' },
          opaqueObject: opaqueObjectDefault,
          schemaFilter: { extra: 'preserved', name: 'schema' },
          schemaTags: ['schema'],
          tags: ['fresh'],
        })
        assert.notStrictEqual(resolverArguments[0].filter, resolverArguments[1].filter)
        assert.strictEqual(resolverArguments[0].opaqueObject, opaqueObjectDefault)
        assert.strictEqual(resolverArguments[1].opaqueObject, opaqueObjectDefault)
        assert.notStrictEqual(resolverArguments[0].schemaFilter, resolverArguments[1].schemaFilter)
        assert.notStrictEqual(resolverArguments[0].schemaTags, resolverArguments[1].schemaTags)
        assert.notStrictEqual(resolverArguments[0].tags, resolverArguments[1].tags)
        assert.deepStrictEqual(schemaFilterDefault, { extra: 'preserved', name: 'schema' })
        assert.deepStrictEqual(schemaTagsDefault, ['schema'])
      })

      it('publishes resolver completion when an inline default getter throws', async () => {
        const Item = new graphql.GraphQLObjectType({
          name: 'ThrowingListItem',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'ThrowingListQuery',
            fields: {
              items: { type: new graphql.GraphQLList(Item) },
            },
          }),
        })
        const { query } = compileQuery(
          listSchema,
          graphql.parse('query ThrowingList { items { value } }')
        )
        const updateChannel = dc.channel('apm:graphql:resolve:updateField')

        for (const values of [
          [Object.defineProperty({}, 'value', {
            get () { throw new Error('first getter boom') },
          })],
          [
            { value: 'first' },
            Object.defineProperty({}, 'value', {
              get () { throw new Error('sibling getter boom') },
            }),
          ],
        ]) {
          const updates = []
          /** @param {{ error?: Error | null, field: { fieldName: string, infoPath?: object } }} message */
          const onUpdate = ({ error, field }) => {
            if (field.fieldName === 'value') {
              updates.push({ error: error?.message, infoPath: field.infoPath })
            }
          }

          updateChannel.subscribe(onUpdate)
          try {
            await executeWithTrace(
              () => assert.throws(() => query({ items: values }, {}, {}), /getter boom/),
              /ThrowingList/
            )
          } finally {
            updateChannel.unsubscribe(onUpdate)
          }

          assert.strictEqual(updates.length, values.length)
          assert.strictEqual(updates.at(-1).infoPath, undefined)
          assert.match(updates.at(-1).error, /getter boom/)
        }
      })

      it('publishes inline default completion when graphql-jit completes each list item', async () => {
        const Item = new graphql.GraphQLObjectType({
          name: 'AsyncListItem',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'AsyncListQuery',
            fields: {
              items: { type: new graphql.GraphQLList(Item) },
            },
          }),
        })
        const { query } = compileQuery(
          listSchema,
          graphql.parse('query AsyncList { items { value } }')
        )
        let resolveFirst
        let rejectThird
        const first = new Promise(resolve => {
          resolveFirst = resolve
        })
        const third = new Promise((_resolve, reject) => {
          rejectThird = reject
        })
        const thirdRejection = assert.rejects(third, { message: 'third rejection' })
        const updateChannel = dc.channel('apm:graphql:resolve:updateField')
        const updates = []
        /** @param {{ error?: Error | null, field: { fieldName: string } }} message */
        const onUpdate = ({ error, field }) => {
          if (field.fieldName === 'value') updates.push(error?.message)
        }
        const assertion = agent.assertSomeTraces(traces => {
          const value = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.ok(value, 'expected the collapsed value resolver span')
          assert.strictEqual(value.error, 0)
        }, { spanResourceMatch: /AsyncList/ })

        updateChannel.subscribe(onUpdate)
        try {
          const execution = query({
            items: [
              { value: first },
              { value: Promise.resolve('second') },
              { value: third },
            ],
          }, {}, {})
          assert.deepStrictEqual(updates, [undefined, undefined, undefined])
          resolveFirst('first')
          rejectThird(new Error('third rejection'))
          await Promise.all([assertion, execution, thirdRejection])
        } finally {
          updateChannel.unsubscribe(onUpdate)
        }
      })

      it('aborts later inline defaults from the completion channel', async () => {
        const Item = new graphql.GraphQLObjectType({
          name: 'CompletionAbortItem',
          fields: {
            value: { type: graphql.GraphQLString },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'CompletionAbortQuery',
            fields: {
              items: { type: new graphql.GraphQLList(Item) },
            },
          }),
        })
        const { query } = compileQuery(
          listSchema,
          graphql.parse('query CompletionAbort { items { value } }')
        )
        const updateChannel = dc.channel('apm:graphql:resolve:updateField')
        let valueUpdates = 0
        /** @param {{ field: { fieldName: string }, rootCtx: { abortController: AbortController } }} message */
        const onUpdate = ({ field, rootCtx }) => {
          if (field.fieldName === 'value') {
            valueUpdates++
            rootCtx.abortController.abort()
          }
        }

        updateChannel.subscribe(onUpdate)
        try {
          await executeWithTrace(
            () => {
              assert.throws(
                () => query({ items: [{ value: 'first' }, { value: 'second' }] }, {}, {}),
                { name: 'AbortError', message: 'Aborted' }
              )
            },
            /CompletionAbort/
          )
        } finally {
          updateChannel.unsubscribe(onUpdate)
        }

        assert.strictEqual(valueUpdates, 1)
      })

      it('isolates overlapping calls to one compiled query sharing a context value', async () => {
        let releaseSlowResolver = () => {}
        const slowResolver = new Promise(resolve => {
          releaseSlowResolver = resolve
        })
        const overlappingSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'OverlappingQuery',
            fields: {
              value: {
                type: graphql.GraphQLString,
                args: { id: { type: new graphql.GraphQLNonNull(graphql.GraphQLString) } },
                resolve: (_source, { id }) => id === 'slow' ? slowResolver.then(() => id) : id,
              },
            },
          }),
        })
        const document = graphql.parse(
          'query SharedOverlap($id: String!) { value(id: $id) }'
        )
        const { query } = compileQuery(overlappingSchema, document)
        const contextValue = {}
        const resolverControllers = new Map()
        const resolverCalls = new Map()
        const resolverChannel = dc.channel('datadog:graphql:resolver:start')
        /** @param {{ abortController: AbortController, resolverInfo: { value: { id: string } } }} message */
        const onResolver = ({ abortController, resolverInfo }) => {
          const { id } = resolverInfo.value
          resolverControllers.set(id, abortController)
          resolverCalls.set(id, (resolverCalls.get(id) ?? 0) + 1)
        }

        /**
         * @param {string} id
         * @returns {Promise<void>}
         */
        const assertExecution = id => agent.assertSomeTraces(traces => {
          const trace = traces.find(trace => trace.some(span =>
            span.name === expectedSchema.server.opName && span.meta['graphql.variables.id'] === id))
          const execute = trace?.find(span => span.name === expectedSchema.server.opName)
          const resolve = trace?.find(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.ok(execute, `expected the ${id} execute span`)
          assert.ok(resolve, `expected the ${id} resolver span`)
          assert.strictEqual(trace.filter(span => span.name === expectedSchema.server.opName).length, 1)
          assert.strictEqual(trace.filter(span => span.name === 'graphql.resolve').length, 1)
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
        }, { spanResourceMatch: /SharedOverlap/, timeoutMs: 3000 })

        const slowAssertion = assertExecution('slow')
        const fastAssertion = assertExecution('fast')

        resolverChannel.subscribe(onResolver)
        try {
          const slowResult = query({}, contextValue, { id: 'slow' })
          const fastResult = query({}, contextValue, { id: 'fast' })
          releaseSlowResolver()

          const [, , slow, fast] = await Promise.all([
            slowAssertion,
            fastAssertion,
            slowResult,
            fastResult,
          ])
          assert.deepStrictEqual(slow.data, { value: 'slow' })
          assert.deepStrictEqual(fast.data, { value: 'fast' })
        } finally {
          resolverChannel.unsubscribe(onResolver)
        }

        assert.strictEqual(resolverCalls.get('slow'), 1)
        assert.strictEqual(resolverCalls.get('fast'), 1)
        assert.notStrictEqual(
          resolverControllers.get('slow'),
          resolverControllers.get('fast'),
          'overlapping executions must not share an abort controller'
        )
      })

      it('keeps a function context through overlapping serial execution', async () => {
        let releaseSlowResolver = () => {}
        const slowResolver = new Promise(resolve => {
          releaseSlowResolver = resolve
        })
        const overlappingSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'OverlappingQuery',
            fields: {
              fast: {
                type: graphql.GraphQLString,
                resolve: () => 'fast',
              },
            },
          }),
          mutation: new graphql.GraphQLObjectType({
            name: 'OverlappingMutation',
            fields: {
              slow: {
                type: graphql.GraphQLString,
                resolve: () => slowResolver.then(() => 'slow'),
              },
              after: {
                type: graphql.GraphQLString,
                resolve: () => 'after',
              },
            },
          }),
        })
        const serialQuery = compileQuery(
          overlappingSchema,
          graphql.parse('mutation SerialOverlap { slow after }')
        ).query
        const fastQuery = compileQuery(
          overlappingSchema,
          graphql.parse('query FastFunctionOverlap { fast }')
        ).query
        const contextValue = function contextValue () {}
        const resolverControllers = new Map()
        const resolverChannel = dc.channel('datadog:graphql:resolver:start')
        /** @param {{ abortController: AbortController, resolverInfo: Record<string, unknown> }} message */
        const onResolver = ({ abortController, resolverInfo }) => {
          resolverControllers.set(Object.keys(resolverInfo)[0], abortController)
        }

        const serialAssertion = agent.assertSomeTraces(traces => {
          const spans = traces.flat()
          const execute = spans.find(span =>
            span.name === expectedSchema.server.opName && /SerialOverlap/.test(span.resource))
          const slow = spans.find(span => span.name === 'graphql.resolve' && span.resource === 'slow:String')
          const after = spans.find(span => span.name === 'graphql.resolve' && span.resource === 'after:String')
          assert.ok(execute, 'expected a SerialOverlap execute span')
          assert.ok(slow, 'expected a slow resolver span')
          assert.ok(after, 'expected an after resolver span')
          assert.strictEqual(slow.parent_id.toString(), execute.span_id.toString())
          assert.strictEqual(after.parent_id.toString(), execute.span_id.toString())
        }, { timeoutMs: 3000 })
        const fastAssertion = agent.assertSomeTraces(traces => {
          const spans = traces.flat()
          const execute = spans.find(span =>
            span.name === expectedSchema.server.opName && /FastFunctionOverlap/.test(span.resource))
          const resolve = spans.find(span => span.name === 'graphql.resolve' && span.resource === 'fast:String')
          assert.ok(execute, 'expected a FastFunctionOverlap execute span')
          assert.ok(resolve, 'expected a fast resolver span')
          assert.strictEqual(resolve.parent_id.toString(), execute.span_id.toString())
        }, { timeoutMs: 3000 })

        resolverChannel.subscribe(onResolver)
        try {
          const serialResult = serialQuery({}, contextValue, {})
          const fastResult = fastQuery({}, contextValue, {})
          releaseSlowResolver()

          const [, , serial, fast] = await Promise.all([
            serialAssertion,
            fastAssertion,
            serialResult,
            fastResult,
          ])
          assert.deepStrictEqual(serial.data, { slow: 'slow', after: 'after' })
          assert.deepStrictEqual(fast.data, { fast: 'fast' })
        } finally {
          resolverChannel.unsubscribe(onResolver)
        }

        assert.strictEqual(resolverControllers.get('slow'), resolverControllers.get('after'))
        assert.notStrictEqual(resolverControllers.get('slow'), resolverControllers.get('fast'))
      })

      it('tags the execute span when a resolver errors', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Boom { boom }'))

        const result = await executeWithTrace(() => query({}, {}, {}), /Boom/, traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 1,
            meta: { 'graphql.operation.name': 'Boom' },
          })
        })
        assert.strictEqual(result.errors.length, 1)
      })

      it('aborts before a JIT-compiled resolver runs', async () => {
        const startChannel = dc.channel('apm:graphql:execute:start')
        /** @param {{ abortController: AbortController }} message */
        const handler = ({ abortController }) => abortController.abort()
        const { query } = compileQuery(schema, graphql.parse('query Blocked { hello }'))

        startChannel.subscribe(handler)
        try {
          await executeWithTrace(
            () => {
              assert.throws(() => query({}, {}, {}), { name: 'AbortError', message: 'Aborted' })
            },
            /Blocked/,
            traces => {
              const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
              const resolve = traces[0].find(span => span.name === 'graphql.resolve')
              assert.strictEqual(execute.error, 0)
              assert.strictEqual(resolve, undefined)
            }
          )
        } finally {
          startChannel.unsubscribe(handler)
        }
      })

      it('traces resolvers when the plugin is enabled after compilation', async () => {
        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(schema, graphql.parse('query EnabledLater { hello }'))
        agent.reload('graphql', { enabled: true, variables: ['name'] })

        await executeWithTrace(() => query({}, {}, {}), /EnabledLater/, traces => {
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assert.ok(resolve, 'expected a graphql.resolve span after enabling the plugin')
        })
      })

      it('retains nested default resolver support across disable and re-enable', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'ReenabledCompilationUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const reenabledSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'ReenabledCompilationQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada' }),
              },
            },
          }),
        })
        const { query } = compileQuery(
          reenabledSchema,
          graphql.parse('query ReenabledCompilation { user { name } }')
        )

        agent.reload('graphql', { enabled: false })
        assert.deepStrictEqual((await query({}, {}, {})).data, { user: { name: 'Ada' } })
        agent.reload('graphql', { enabled: true })

        const result = await executeWithTrace(() => query({}, {}, {}), /ReenabledCompilation/, traces => {
          const resources = traces[0]
            .filter(span => span.name === 'graphql.resolve')
            .map(span => span.resource)
          assert.deepStrictEqual(resources, ['user:ReenabledCompilationUser', 'name:String'])
        })
        assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
      })

      it('does not alter nested default resolvers compiled while the plugin is disabled', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'DisabledCompilationUser',
          fields: {
            name: {
              type: graphql.GraphQLString,
              resolve: source => source.name,
            },
            nickname: {
              type: graphql.GraphQLString,
              resolve: source => ({
                /**
                 * @param {(value: string) => void} resolve
                 * @returns {string}
                 */
                then (resolve) {
                  queueMicrotask(() => resolve(source.nickname))
                  return 'wrong'
                },
              }),
            },
          },
        })
        const disabledCompilationSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'DisabledCompilationQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada', nickname: 'Grace' }),
              },
            },
          }),
        })

        agent.reload('graphql', { enabled: false, collapse: false })
        const { query } = compileQuery(
          disabledCompilationSchema,
          graphql.parse('query DisabledCompilation { user { name nickname } }')
        )
        agent.reload('graphql', { enabled: true, collapse: false })

        const result = await executeWithTrace(() => query({}, {}, {}), /DisabledCompilation/, traces => {
          const resolveSpans = traces[0].filter(span => span.name === 'graphql.resolve')
          const userSpan = resolveSpans.find(span => span.resource === 'user:DisabledCompilationUser')
          const nameSpan = resolveSpans.find(span => span.resource === 'name:String')
          const nicknameSpan = resolveSpans.find(span => span.resource === 'nickname:String')

          assert.ok(userSpan)
          assert.ok(nameSpan)
          assert.ok(nicknameSpan)
          assert.strictEqual(nameSpan.parent_id.toString(), userSpan.span_id.toString())
          assert.strictEqual(nicknameSpan.parent_id.toString(), userSpan.span_id.toString())
        })
        assert.deepStrictEqual(result.data, { user: { name: 'Ada', nickname: 'Grace' } })
      })

      it('preserves falsy nested sources when compiled while the plugin is disabled', async () => {
        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(
          buildFalsySourceSchema(),
          graphql.parse('query DisabledFalsySources { zero { value } falseValue { value } emptyString { value } }')
        )
        agent.reload('graphql', { enabled: true })

        const result = await executeWithTrace(() => query({}, {}, {}), /DisabledFalsySources/, traces => {
          const valueSpan = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.strictEqual(valueSpan, undefined)
        })
        assert.deepStrictEqual(result.data, {
          zero: { value: null },
          falseValue: { value: null },
          emptyString: { value: null },
        })
      })
    })
  })

  describe('graphql-jit with GraphQL 17', () => {
    let compileQuery
    let graphql

    useSandbox(["'graphql-jit@0.8.8'", "'graphql@17.0.2'"], false, [])

    before(() => {
      return agent.load('graphql')
    })

    before(() => {
      const sandboxRequire = createRequire(join(sandboxCwd(), 'package.json'))
      compileQuery = sandboxRequire('graphql-jit').compileQuery
      graphql = sandboxRequire('graphql')
    })

    after(() => {
      return agent.close()
    })

    it('traces and publishes a default resolver without an argument list', async () => {
      const User = new graphql.GraphQLObjectType({
        name: 'User',
        fields: {
          name: { type: graphql.GraphQLString },
        },
      })
      const schema = new graphql.GraphQLSchema({
        query: new graphql.GraphQLObjectType({
          name: 'Query',
          fields: {
            user: {
              type: User,
              resolve: () => ({ name: 'Ada' }),
            },
          },
        }),
      })
      const document = graphql.parse('query GraphQL17Default { user { name } }')
      const fieldNode = document.definitions[0].selectionSet.selections[0].selectionSet.selections[0]
      const { query } = compileQuery(schema, document)
      const resolverStartChannel = dc.channel('datadog:graphql:resolver:start')
      const resolverInfos = []
      /** @param {{ resolverInfo: Record<string, unknown> }} message */
      const onResolverStart = ({ resolverInfo }) => resolverInfos.push(resolverInfo)

      resolverStartChannel.subscribe(onResolverStart)
      try {
        assert.strictEqual(fieldNode.arguments, undefined)
        const result = await executeWithTrace(() => query({}, {}, {}), /GraphQL17Default/, traces => {
          const span = traces[0].find(span => span.resource === 'name:String')
          assert.ok(span)
        })
        assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
      } finally {
        resolverStartChannel.unsubscribe(onResolverStart)
      }

      assert.deepStrictEqual(resolverInfos, [{ user: {} }, { name: {} }])
    })
  })
})
