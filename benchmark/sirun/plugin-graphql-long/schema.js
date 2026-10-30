'use strict'

const graphql = require('../../../versions/graphql').get()

const object = {}
const resolved = {
  address: Promise.resolve(object),
  civicNumber: Promise.resolve('123'),
  colour: Promise.resolve('#ffffff'),
  colours: Promise.resolve([object, object]),
  friends: Promise.resolve(Array.from({ length: 20 }, () => object)),
  name: Promise.resolve('test'),
  owner: Promise.resolve(object),
  pets: Promise.resolve(Array.from({ length: 20 }, () => object)),
  petName: Promise.resolve('foo bar'),
  street: Promise.resolve('foo street'),
  type: Promise.resolve('dog'),
}

const Human = new graphql.GraphQLObjectType({
  name: 'Human',
  fields: {
    name: {
      type: graphql.GraphQLString,
      resolve (obj, args) {
        return resolved.name
      },
    },
    address: {
      type: new graphql.GraphQLObjectType({
        name: 'Address',
        fields: {
          civicNumber: {
            type: graphql.GraphQLString,
            resolve () {
              return resolved.civicNumber
            },
          },
          street: {
            type: graphql.GraphQLString,
            resolve () {
              return resolved.street
            },
          },
        },
      }),
      resolve (obj, args) {
        return resolved.address
      },
    },
    pets: {
      type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
        name: 'Pet',
        fields: () => ({
          type: {
            type: graphql.GraphQLString,
            resolve (obj, args) {
              return resolved.type
            },
          },
          name: {
            type: graphql.GraphQLString,
            resolve (obj, args) {
              return resolved.petName
            },
          },
          owner: {
            type: Human,
            resolve (obj, args) {
              return resolved.owner
            },
          },
          colours: {
            type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
              name: 'Colour',
              fields: {
                code: {
                  type: graphql.GraphQLString,
                  resolve (obj, args) {
                    return resolved.colour
                  },
                },
              },
            })),
            resolve (obj, args) {
              return resolved.colours
            },
          },
        }),
      }))),
      resolve (obj, args) {
        return resolved.pets
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
        resolve (obj, args) {
          return resolved.friends
        },
      },
    },
  }),
})

module.exports = schema
