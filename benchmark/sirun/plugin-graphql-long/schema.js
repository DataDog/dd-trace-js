'use strict'

const { setImmediate } = require('node:timers/promises')

const graphql = require('../../../versions/graphql').get()

const Human = new graphql.GraphQLObjectType({
  name: 'Human',
  fields: {
    name: {
      type: graphql.GraphQLString,
      async resolve (obj, args) {
        await setImmediate()
        return 'test'
      },
    },
    address: {
      type: new graphql.GraphQLObjectType({
        name: 'Address',
        fields: {
          civicNumber: {
            type: graphql.GraphQLString,
            async resolve () {
              await setImmediate()
              return '123'
            },
          },
          street: {
            type: graphql.GraphQLString,
            async resolve () {
              await setImmediate()
              return 'foo street'
            },
          },
        },
      }),
      async resolve (obj, args) {
        await setImmediate()
        return {}
      },
    },
    pets: {
      type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
        name: 'Pet',
        fields: () => ({
          type: {
            type: graphql.GraphQLString,
            async resolve (obj, args) {
              await setImmediate()
              return 'dog'
            },
          },
          name: {
            type: graphql.GraphQLString,
            async resolve (obj, args) {
              await setImmediate()
              return 'foo bar'
            },
          },
          owner: {
            type: Human,
            async resolve (obj, args) {
              await setImmediate()
              return {}
            },
          },
          colours: {
            type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
              name: 'Colour',
              fields: {
                code: {
                  type: graphql.GraphQLString,
                  async resolve (obj, args) {
                    await setImmediate()
                    return '#ffffff'
                  },
                },
              },
            })),
            async resolve (obj, args) {
              await setImmediate()
              return [{}, {}]
            },
          },
        }),
      }))),
      async resolve (obj, args) {
        await setImmediate()
        const promises = []

        for (let i = 0; i < 20; i++) {
          promises.push(Promise.resolve({}))
        }

        return Promise.all(promises)
      },
    },
  },
})

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'RootQueryType',
    fields: {
      friends: {
        type: new graphql.GraphQLList(Human),
        async resolve (obj, args) {
          await setImmediate()
          const promises = []

          for (let i = 0; i < 20; i++) {
            promises.push(Promise.resolve({}))
          }

          return Promise.all(promises)
        },
      },
    },
  }),
})

module.exports = schema
