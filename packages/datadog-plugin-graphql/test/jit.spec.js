'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema } = require('./naming')

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
     * @returns {AsyncGenerator<{ greeting: string }>}
     * @yields {{ greeting: string }}
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

    withVersions('graphql', 'graphql-jit', '>=0.7.0', version => {
      before(() => {
        return agent.load('graphql', { variables: ['id', 'name'] })
      })

      before(() => {
        // graphql-jit resolves its `graphql` peer up to the same instance this
        // require sees, so the schema and the compiler agree on graphql types.
        graphql = require('graphql')
        compileQuery = require(`../../../versions/graphql-jit@${version}`).get().compileQuery
        schema = buildSchema()
      })

      after(() => {
        return agent.close()
      })

      it('emits graphql.execute for a JIT-compiled query', async () => {
        const document = graphql.parse('query GetHello($name: String!) { hello(name: $name) }')
        const { query } = compileQuery(schema, document)

        const assertion = agent.assertSomeTraces(traces => {
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
        }, { spanResourceMatch: /GetHello/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, { name: 'Ada' }))(),
        ])
        assert.deepStrictEqual(result.data, { hello: 'Ada' })
      })

      it('traces a compiled default field resolver', async () => {
        const { query } = compileQuery(schema, graphql.parse('query DefaultHello { defaultHello }'))

        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assertObjectContains(resolve, {
            resource: 'defaultHello:String',
            meta: { 'graphql.field.name': 'defaultHello' },
          })
        }, { spanResourceMatch: /DefaultHello/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({ defaultHello: 'default world' }, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { defaultHello: 'default world' })
      })

      it('traces a promise-valued default field', async () => {
        const { query } = compileQuery(schema, graphql.parse('query AsyncDefault { defaultHello }'))
        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'defaultHello:String')
          assert.ok(resolve, 'expected the promise-valued default resolver span')
          assert.strictEqual(resolve.error, 0)
        }, { spanResourceMatch: /AsyncDefault/ })

        const [, result] = await Promise.all([
          assertion,
          query({ defaultHello: Promise.resolve('async default') }, {}, {}),
        ])
        assert.deepStrictEqual(result.data, { defaultHello: 'async default' })
      })

      it('tags errors thrown by a default field getter', async () => {
        const { query } = compileQuery(schema, graphql.parse('query DefaultGetterError { defaultHello }'))
        const rootValue = Object.defineProperty({}, 'defaultHello', {
          get () {
            throw new Error('default getter boom')
          },
        })
        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'defaultHello:String')
          assert.ok(resolve, 'expected the throwing default resolver span')
          assert.strictEqual(resolve.error, 1)
        }, { spanResourceMatch: /DefaultGetterError/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query(rootValue, {}, {}))(),
        ])
        assert.strictEqual(result.errors.length, 1)
        assert.strictEqual(result.errors[0].message, 'default getter boom')
      })

      it('keeps collapsed abstract fields distinct and correctly parented by schema coordinate', async () => {
        const { query } = compileQuery(
          buildCoordinateSchema(),
          graphql.parse('query Coordinates { results { profile { value } } }')
        )

        const assertion = agent.assertSomeTraces(traces => {
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
        }, { spanResourceMatch: /Coordinates/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, {
          results: [
            { profile: { value: 'person' } },
            { profile: { value: 'animal' } },
          ],
        })
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
            graphql.parse('query Uncollapsed { items { profile { value } } }')
          )
          const assertion = agent.assertSomeTraces(traces => {
            const spans = traces[0].filter(span => span.name === 'graphql.resolve')
            for (let i = 0; i < 3; i++) {
              const profile = spans.find(span => span.meta['graphql.field.path'] === `items.${i}.profile`)
              const value = spans.find(span => span.meta['graphql.field.path'] === `items.${i}.profile.value`)
              assert.ok(profile, `expected items.${i}.profile span`)
              assert.ok(value, `expected items.${i}.profile.value span`)
              assert.strictEqual(value.parent_id.toString(), profile.span_id.toString())
            }
          }, { spanResourceMatch: /Uncollapsed/ })

          const [, result] = await Promise.all([
            assertion,
            (async () => query({}, {}, {}))(),
          ])
          assert.deepStrictEqual(result.data, {
            items: [
              { profile: { value: 'one' } },
              { profile: { value: 'two' } },
              { profile: { value: 'three' } },
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
        const assertion = agent.assertSomeTraces(traces => {
          assert.ok(traces[0].some(span => span.name === expectedSchema.server.opName))
          assert.ok(traces[0].some(span => span.name === 'graphql.resolve'))
        }, { spanResourceMatch: /KnownOperation/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { hello: 'world' })
      })

      it('preserves a configured resolver info enricher', async () => {
        let enrichedValue
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
                 * @param {{ enriched?: string }} info
                 * @returns {string}
                 */
                resolve (_source, _args, _context, info) {
                  enrichedValue = info.enriched
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
            resolverInfoEnricher: () => ({ enriched: 'preserved' }),
          }
        )
        const assertion = agent.assertSomeTraces(() => {}, { spanResourceMatch: /Enriched/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { value: 'value' })
        assert.strictEqual(enrichedValue, 'preserved')
      })

      it('traces nested default field resolvers and publishes their security channels', async () => {
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
        const iastChannel = dc.channel('apm:graphql:resolve:start')
        const appsecChannel = dc.channel('datadog:graphql:resolver:start')
        const iastFields = []
        const appsecFields = []
        /** @param {{ info: { fieldName: string } }} message */
        const onIastResolve = ({ info }) => iastFields.push(info.fieldName)
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onAppsecResolve = ({ resolverInfo }) => appsecFields.push(...Object.keys(resolverInfo))

        const assertion = agent.assertSomeTraces(traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          const user = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'user:NestedDefaultUser')
          const name = traces[0].find(span => span.name === 'graphql.resolve' && span.resource === 'name:String')
          assert.ok(execute, 'expected a NestedDefault execute span')
          assert.ok(user, 'expected an explicit user resolver span')
          assert.ok(name, 'expected a nested default resolver span')
          assert.strictEqual(user.parent_id.toString(), execute.span_id.toString())
          assert.strictEqual(name.parent_id.toString(), user.span_id.toString())
        }, { spanResourceMatch: /NestedDefault/ })

        iastChannel.subscribe(onIastResolve)
        appsecChannel.subscribe(onAppsecResolve)
        try {
          const { query } = compileQuery(
            nestedSchema,
            graphql.parse('query NestedDefault { user { name } }')
          )
          const [, result] = await Promise.all([
            assertion,
            (async () => query({}, {}, {}))(),
          ])
          assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
        } finally {
          iastChannel.unsubscribe(onIastResolve)
          appsecChannel.unsubscribe(onAppsecResolve)
        }

        assert.deepStrictEqual(iastFields.sort(), ['name', 'user'])
        assert.deepStrictEqual(appsecFields.sort(), ['name', 'user'])
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

        const assertion = agent.assertSomeTraces(traces => {
          const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
          assert.strictEqual(execute.error, 1)
        }, { spanResourceMatch: /NestedTypeFailure/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { user: null })
        assert.strictEqual(result.errors.length, 1)
        assert.match(result.errors[0].message, /Expected value of type "RejectedNestedUser"/)
      })

      it('preserves falsy nested sources while deferring default resolvers', async () => {
        const { query } = compileQuery(
          buildFalsySourceSchema(),
          graphql.parse('query FalsySources { zero { value } falseValue { value } emptyString { value } }')
        )

        const assertion = agent.assertSomeTraces(traces => {
          const valueSpans = traces[0].filter(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.strictEqual(valueSpans.length, 3)
        }, { spanResourceMatch: /FalsySources/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, {
          zero: { value: null },
          falseValue: { value: null },
          emptyString: { value: null },
        })
      })

      it('traces every execution of a compiled query, not only the first', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Repeat { hello }'))

        for (let run = 0; run < 2; run++) {
          const assertion = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
            assert.strictEqual(traces[0][0].meta['graphql.operation.name'], 'Repeat')
          }, { spanResourceMatch: /Repeat/ })

          await Promise.all([
            assertion,
            (async () => query({}, {}, {}))(),
          ])
        }
      })

      it('traces a promise-returning execution', async () => {
        const { query } = compileQuery(schema, graphql.parse('query Slow { slow }'))

        const assertion = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 0,
            meta: { 'graphql.operation.type': 'query', 'graphql.operation.name': 'Slow' },
          })
        }, { spanResourceMatch: /Slow/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { slow: 'later' })
      })

      it('traces a mutation execution', async () => {
        const document = graphql.parse('mutation SetHello($name: String!) { setHello(name: $name) }')
        const { query } = compileQuery(schema, document)

        const assertion = agent.assertSomeTraces(traces => {
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
        }, { spanResourceMatch: /SetHello/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, { name: 'changed' }))(),
        ])
        assert.deepStrictEqual(result.data, { setHello: 'changed' })
      })

      it('traces every subscription payload execution', async () => {
        const document = graphql.parse(
          'subscription Greetings($name: String!) { greeting(name: $name) }'
        )
        const { subscribe } = compileQuery(schema, document)
        const stream = await subscribe({}, {}, { name: 'hello' })

        for (const suffix of ['one', 'two']) {
          const assertion = agent.assertSomeTraces(traces => {
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
          }, { spanResourceMatch: /Greetings/ })

          const [, payload] = await Promise.all([assertion, stream.next()])
          assert.deepStrictEqual(payload, {
            value: { data: { greeting: `hello ${suffix}` } },
            done: false,
          })
        }

        assert.deepStrictEqual(await stream.next(), { value: undefined, done: true })
      })

      it('publishes resolver security channels once per JIT resolver', async () => {
        const document = graphql.parse('query ResolverChannels { hello defaultHello }')
        const { query } = compileQuery(schema, document)
        const iastChannel = dc.channel('apm:graphql:resolve:start')
        const appsecChannel = dc.channel('datadog:graphql:resolver:start')
        const iastFields = []
        const appsecFields = []
        /** @param {{ info: { fieldName: string } }} message */
        const onIastResolve = ({ info }) => iastFields.push(info.fieldName)
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onAppsecResolve = ({ resolverInfo }) => appsecFields.push(...Object.keys(resolverInfo))

        iastChannel.subscribe(onIastResolve)
        appsecChannel.subscribe(onAppsecResolve)
        try {
          const assertion = agent.assertSomeTraces(traces => {
            assert.strictEqual(
              traces[0].filter(span => span.name === 'graphql.resolve').length,
              2
            )
          }, { spanResourceMatch: /ResolverChannels/ })

          const [, result] = await Promise.all([
            assertion,
            (async () => query({ defaultHello: 'default' }, {}, {}))(),
          ])
          assert.deepStrictEqual(result.data, { hello: 'world', defaultHello: 'default' })
        } finally {
          iastChannel.unsubscribe(onIastResolve)
          appsecChannel.unsubscribe(onAppsecResolve)
        }

        assert.deepStrictEqual(iastFields.sort(), ['defaultHello', 'hello'])
        assert.deepStrictEqual(appsecFields.sort(), ['defaultHello', 'hello'])
      })

      it('keeps AppSec resolver calls when depth disables resolver spans', async () => {
        const appsecChannel = dc.channel('datadog:graphql:resolver:start')
        const appsecFields = []
        /** @param {{ resolverInfo: Record<string, unknown> }} message */
        const onAppsecResolve = ({ resolverInfo }) => appsecFields.push(...Object.keys(resolverInfo))

        agent.reload('graphql', { depth: 0 })
        appsecChannel.subscribe(onAppsecResolve)
        try {
          const { query } = compileQuery(
            schema,
            graphql.parse('query DepthDisabled { hello defaultHello }')
          )
          const assertion = agent.assertSomeTraces(traces => {
            assert.strictEqual(
              traces[0].filter(span => span.name === 'graphql.resolve').length,
              0
            )
          }, { spanResourceMatch: /DepthDisabled/ })

          const [, result] = await Promise.all([
            assertion,
            (async () => query({ defaultHello: 'default' }, {}, {}))(),
          ])
          assert.deepStrictEqual(result.data, { hello: 'world', defaultHello: 'default' })
        } finally {
          appsecChannel.unsubscribe(onAppsecResolve)
          agent.reload('graphql', { variables: ['id', 'name'] })
        }

        assert.deepStrictEqual(appsecFields.sort(), ['defaultHello', 'hello'])
      })

      it('aborts explicit and inline default resolvers from the AppSec channel', async () => {
        const appsecChannel = dc.channel('datadog:graphql:resolver:start')

        for (const fieldName of ['hello', 'defaultHello']) {
          const { query } = compileQuery(
            schema,
            graphql.parse(`query ResolverBlocked { ${fieldName} }`)
          )
          /** @param {{ abortController: AbortController, resolverInfo: Record<string, unknown> }} message */
          const onAppsecResolve = ({ abortController, resolverInfo }) => {
            if (resolverInfo[fieldName]) abortController.abort()
          }

          appsecChannel.subscribe(onAppsecResolve)
          try {
            const assertion = agent.assertSomeTraces(traces => {
              const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
              assert.strictEqual(execute.error, 1)
            }, { spanResourceMatch: /ResolverBlocked/ })

            const [, result] = await Promise.all([
              assertion,
              (async () => query({ defaultHello: 'default' }, {}, {}))(),
            ])
            assert.strictEqual(result.errors.length, 1)
            assert.strictEqual(result.errors[0].originalError?.name, 'AbortError')
          } finally {
            appsecChannel.unsubscribe(onAppsecResolve)
          }
        }
      })

      it('publishes AppSec and IAST data for every collapsed list resolver invocation', async () => {
        const Item = new graphql.GraphQLObjectType({
          name: 'SecurityListItem',
          fields: {
            value: {
              type: graphql.GraphQLString,
              args: { input: { type: graphql.GraphQLString } },
            },
            plain: {
              type: graphql.GraphQLString,
            },
          },
        })
        const listSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'SecurityListQuery',
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
          graphql.parse('query SecurityList { items { value(input: "testattack") plain } }')
        )
        const iastChannel = dc.channel('apm:graphql:resolve:start')
        const appsecChannel = dc.channel('datadog:graphql:resolver:start')
        const iastArgs = new Map([['plain', new Set()], ['value', new Set()]])
        const appsecCalls = new Map()
        const appsecInputs = []
        /** @param {{ args: object, info: { fieldName: string } }} message */
        const onIastResolve = ({ args, info }) => {
          iastArgs.get(info.fieldName)?.add(args)
        }
        /** @param {{ resolverInfo: Record<string, { input?: string }> }} message */
        const onAppsecResolve = ({ resolverInfo }) => {
          const [fieldName] = Object.keys(resolverInfo)
          appsecCalls.set(fieldName, (appsecCalls.get(fieldName) ?? 0) + 1)
          if (resolverInfo.value) appsecInputs.push(resolverInfo.value.input)
        }

        iastChannel.subscribe(onIastResolve)
        appsecChannel.subscribe(onAppsecResolve)
        try {
          const assertion = agent.assertSomeTraces(traces => {
            const valueSpans = traces[0].filter(span => span.name === 'graphql.resolve' &&
              (span.resource === 'value:String' || span.resource === 'plain:String'))
            assert.strictEqual(valueSpans.length, 2)
          }, { spanResourceMatch: /SecurityList/ })

          const [, result] = await Promise.all([
            assertion,
            (async () => query({}, {}, {}))(),
          ])
          assert.deepStrictEqual(result.data, {
            items: [
              { value: 'one', plain: 'one' },
              { value: 'two', plain: 'two' },
              { value: 'three', plain: 'three' },
            ],
          })
        } finally {
          iastChannel.unsubscribe(onIastResolve)
          appsecChannel.unsubscribe(onAppsecResolve)
        }

        assert.strictEqual(iastArgs.get('plain').size, 3)
        assert.strictEqual(iastArgs.get('value').size, 3)
        assert.strictEqual(appsecCalls.get('plain'), 3)
        assert.strictEqual(appsecCalls.get('value'), 3)
        assert.deepStrictEqual(appsecInputs, ['testattack', 'testattack', 'testattack'])
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

        const assertion = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: expectedSchema.server.opName,
            error: 1,
            meta: { 'graphql.operation.name': 'Boom' },
          })
        }, { spanResourceMatch: /Boom/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.strictEqual(result.errors.length, 1)
      })

      it('aborts before a JIT-compiled resolver runs', async () => {
        const startChannel = dc.channel('apm:graphql:execute:start')
        /** @param {{ abortController: AbortController }} message */
        const handler = ({ abortController }) => abortController.abort()
        const { query } = compileQuery(schema, graphql.parse('query Blocked { hello }'))

        startChannel.subscribe(handler)
        try {
          const assertion = agent.assertSomeTraces(traces => {
            const execute = traces[0].find(span => span.name === expectedSchema.server.opName)
            const resolve = traces[0].find(span => span.name === 'graphql.resolve')
            assert.strictEqual(execute.error, 0)
            assert.strictEqual(resolve, undefined)
          }, { spanResourceMatch: /Blocked/ })

          await Promise.all([
            assertion,
            (async () => {
              assert.throws(() => query({}, {}, {}), { name: 'AbortError', message: 'Aborted' })
            })(),
          ])
        } finally {
          startChannel.unsubscribe(handler)
        }
      })

      it('traces resolvers when the plugin is enabled after compilation', async () => {
        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(schema, graphql.parse('query EnabledLater { hello }'))
        agent.reload('graphql', { enabled: true, variables: ['name'] })

        const assertion = agent.assertSomeTraces(traces => {
          const resolve = traces[0].find(span => span.name === 'graphql.resolve')
          assert.ok(resolve, 'expected a graphql.resolve span after enabling the plugin')
        }, { spanResourceMatch: /EnabledLater/ })

        await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
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

        const assertion = agent.assertSomeTraces(traces => {
          const resources = traces[0]
            .filter(span => span.name === 'graphql.resolve')
            .map(span => span.resource)
          assert.deepStrictEqual(resources, ['user:ReenabledCompilationUser', 'name:String'])
        }, { spanResourceMatch: /ReenabledCompilation/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
      })

      it('does not alter nested default resolvers compiled while the plugin is disabled', async () => {
        const User = new graphql.GraphQLObjectType({
          name: 'DisabledCompilationUser',
          fields: {
            name: { type: graphql.GraphQLString },
          },
        })
        const disabledCompilationSchema = new graphql.GraphQLSchema({
          query: new graphql.GraphQLObjectType({
            name: 'DisabledCompilationQuery',
            fields: {
              user: {
                type: User,
                resolve: () => ({ name: 'Ada' }),
              },
            },
          }),
        })

        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(
          disabledCompilationSchema,
          graphql.parse('query DisabledCompilation { user { name } }')
        )
        agent.reload('graphql', { enabled: true })

        const assertion = agent.assertSomeTraces(traces => {
          const resolveSpans = traces[0].filter(span => span.name === 'graphql.resolve')
          assert.deepStrictEqual(resolveSpans.map(span => span.resource), ['user:DisabledCompilationUser'])
        }, { spanResourceMatch: /DisabledCompilation/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, { user: { name: 'Ada' } })
      })

      it('preserves falsy nested sources when compiled while the plugin is disabled', async () => {
        agent.reload('graphql', { enabled: false })
        const { query } = compileQuery(
          buildFalsySourceSchema(),
          graphql.parse('query DisabledFalsySources { zero { value } falseValue { value } emptyString { value } }')
        )
        agent.reload('graphql', { enabled: true })

        const assertion = agent.assertSomeTraces(traces => {
          const valueSpan = traces[0].find(span =>
            span.name === 'graphql.resolve' && span.resource === 'value:String')
          assert.strictEqual(valueSpan, undefined)
        }, { spanResourceMatch: /DisabledFalsySources/ })

        const [, result] = await Promise.all([
          assertion,
          (async () => query({}, {}, {}))(),
        ])
        assert.deepStrictEqual(result.data, {
          zero: { value: null },
          falseValue: { value: null },
          emptyString: { value: null },
        })
      })
    })
  })
})
