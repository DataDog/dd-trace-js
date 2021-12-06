'use strict'

const graphql = require('../../../versions/graphql/node_modules/graphql')

const Human = new graphql.GraphQLObjectType({
  name: 'Human',
  fields: {
    name: {
      type: graphql.GraphQLString,
      async resolve (obj, args) {
        const name = await Promise.resolve('test')

        return name
      }
    },
    address: {
      type: new graphql.GraphQLObjectType({
        name: 'Address',
        fields: {
          civicNumber: {
            type: graphql.GraphQLString,
            async resolve () {
              const civicNumber = await Promise.resolve('123')

              return civicNumber
            }
          },
          street: {
            type: graphql.GraphQLString,
            async resolve () {
              const street = await Promise.resolve('foo street')

              return street
            }
          }
        }
      }),
      async resolve (obj, args) {
        const address = await Promise.resolve({})

        return address
      }
    },
    pets: {
      type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
        name: 'Pet',
        fields: () => ({
          type: {
            type: graphql.GraphQLString,
            async resolve (obj, args) {
              const type = await Promise.resolve('dog')

              return type
            }
          },
          name: {
            type: graphql.GraphQLString,
            async resolve (obj, args) {
              const name = await Promise.resolve('foo bar')

              return name
            }
          },
          owner: {
            type: Human,
            async resolve (obj, args) {
              const owner = await Promise.resolve({})

              return owner
            }
          },
          colours: {
            type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
              name: 'Colour',
              fields: {
                code: {
                  type: graphql.GraphQLString,
                  async resolve (obj, args) {
                    const code = await Promise.resolve('#ffffff')

                    return code
                  }
                }
              }
            })),
            async resolve (obj, args) {
              const colours = await Promise.resolve([{}, {}])

              return colours
            }
          }
        })
      }))),
      async resolve (obj, args) {
        const promises = []

        for (let i = 0; i < 100; i++) {
          promises.push(await Promise.resolve({}))
        }

        const pets = await Promise.all(promises)

        return pets
      }
    }
  }
})

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'RootQueryType',
    fields: {
      friends: {
        type: new graphql.GraphQLList(Human),
        async resolve (obj, args) {
          const promises = []

          for (let i = 0; i < 1000; i++) {
            promises.push(await Promise.resolve({}))
          }

          const friends = await Promise.all(promises)

          return friends
        }
      }
    }
  })
})

module.exports = schema
