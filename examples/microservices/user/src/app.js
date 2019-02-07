'use strict'

const express = require('express')
const graphql = require('graphql')
const graphqlHTTP = require('express-graphql')
const userRepository = require('./user_repository')
const expressWinston = require('express-winston')
const logger = require('./logger')

const app = express()

const schema = graphql.buildSchema(`
  type Query {
    users: [User]
  }

  type User {
    name: String
    age: Int
  }
`)

const rootValue = {
  users: () => userRepository.all()
}

app.use(expressWinston.logger({
  winstonInstance: logger
}))

app.use('/graphql', graphqlHTTP({
  schema,
  rootValue,
  graphiql: true
}))

app.use(expressWinston.errorLogger({
  winstonInstance: logger
}))

module.exports = app
