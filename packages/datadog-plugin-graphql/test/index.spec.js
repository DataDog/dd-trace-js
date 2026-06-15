'use strict'
const assert = require('node:assert/strict')
const http = require('node:http')
const { performance } = require('perf_hooks')
const { inspect } = require('node:util')
const axios = require('axios')
const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const plugin = require('../src')
const { expectedSchema, rawExpectedSchema } = require('./naming')
describe('Plugin', () => {
  let tracer
  let graphql
  let schema
  let sort
  let markFast
  let markSlow
  let markSync

  // Mock Mongoose Query that throws if .then() or .exec() is called more than once.
  class Query {
    constructor(value) {
      this._value = value
      this._called = false
    }

    then(onFulfilled, onRejected) {
      if (this._called) {
        throw new Error('This thenable has already been executed.')
      }
      this._called = true
      return Promise.resolve(this._value).then(onFulfilled, onRejected)
    }

    exec() {
      if (this._called) {
        return Promise.reject(new Error('This thenable has already been executed.'))
      }
      this._called = true
      return Promise.resolve(this._value)
    }
  }

  function buildSchema() {
    const Human = new graphql.GraphQLObjectType({
      name: 'Human',
      fields: {
        name: {
          type: graphql.GraphQLString,
          resolve(obj, args) {
            return 'test'
          },
        },
        address: {
          type: new graphql.GraphQLObjectType({
            name: 'Address',
            fields: {
              civicNumber: {
                type: graphql.GraphQLString,
                resolve: () => 123,
              },
              street: {
                type: graphql.GraphQLString,
                resolve: () => 'foo street',
              },
            },
          }),
          resolve(obj, args) {
            return {}
          },
        },
        pets: {
          type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
            name: 'Pet',
            fields: () => ({
              type: {
                type: graphql.GraphQLString,
                resolve: () => 'dog',
              },
              name: {
                type: graphql.GraphQLString,
                resolve: () => 'foo bar',
              },
              owner: {
                type: Human,
                resolve: () => ({}),
              },
              colours: {
                type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
                  name: 'Colour',
                  fields: {
                    code: {
                      type: graphql.GraphQLString,
                      resolve: () => '#ffffff',
                    },
                  },
                })),
                resolve(obj, args) {
                  return [{}, {}]
                },
              },
            }),
          }))),
          resolve(obj, args) {
            return [{}, {}, {}]
          },
        },
        fastAsyncField: {
          type: graphql.GraphQLString,
          resolve(obj, args) {
            return new Promise((resolve) => {
              markFast = performance.now()
              resolve('fast field')
            })
          },
        },
        slowAsyncField: {
          type: graphql.GraphQLString,
          resolve(obj, args) {
            return new Promise((resolve) => {
              markSlow = performance.now()
              resolve('slow field')
            })
          },
        },
        syncField: {
          type: graphql.GraphQLString,
          resolve(obj, args) {
            markSync = performance.now()
            return 'sync field'
          },
        },
        oneTime: {
          type: graphql.GraphQLString,
          resolve: () => new Query('one-time result'),
        },
      },
    })
    schema = new graphql.GraphQLSchema({
      query: new graphql.GraphQLObjectType({
        name: 'RootQueryType',
        fields: {
          hello: {
            type: graphql.GraphQLString,
            args: {
              name: {
                type: graphql.GraphQLString,
              },
              title: {
                type: graphql.GraphQLString,
                defaultValue: null,
              },
            },
            resolve(obj, args) {
              return args.name
            },
          },
          human: {
            type: Human,
            resolve(obj, args) {
              return Promise.resolve({})
            },
          },
          friends: {
            type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
              name: 'Friend',
              fields: {
                name: {
                  type: graphql.GraphQLString,
                  resolve(obj, args) {
                    return 'friend'
                  },
                },
              },
            }))),
            resolve(obj, args) {
              return [{}, {}, {}]
            },
          },
        },
      }),
    })

    return schema
  }

  // ... rest of the file remains the same ...
}