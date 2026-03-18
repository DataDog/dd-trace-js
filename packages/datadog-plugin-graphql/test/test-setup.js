'use strict'

class GraphqlTestSetup {
  async setup (module) {
    this.graphql = module

    const {
      GraphQLSchema,
      GraphQLObjectType,
      GraphQLString,
    } = module

    const queryType = new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: {
          type: GraphQLString,
          args: {
            name: { type: GraphQLString },
          },
          resolve (_, args) {
            return `Hello, ${(args && args.name) || 'World'}!`
          },
        },
        error: {
          type: GraphQLString,
          resolve () {
            throw new Error('Intentional test error')
          },
        },
      },
    })

    this.schema = new GraphQLSchema({ query: queryType })
    this.validQuery = '{ hello(name: "Test") }'
    this.errorQuery = '{ error }'
    this.invalidSyntax = '{ invalid query !!!'
    this.invalidQuery = '{ nonExistentField }'

    // Pre-parse documents for execute/validate tests to avoid triggering extra parse spans
    this.validDocument = module.parse(this.validQuery)
    this.errorDocument = module.parse(this.errorQuery)
    this.invalidDocument = module.parse(this.invalidQuery)

    // Detect graphql major version for API compatibility
    // graphql@16+ requires named args for execute
    const versionStr = module.version || ''
    const major = parseInt(versionStr.split('.')[0], 10)
    this._useNamedArgs = major >= 16
  }

  async teardown () {
    this.graphql = undefined
    this.schema = undefined
  }

  async graphqlParse () {
    return this.graphql.parse(this.validQuery)
  }

  async graphqlParseError () {
    return this.graphql.parse(this.invalidSyntax)
  }

  async graphqlValidate () {
    return this.graphql.validate(this.schema, this.validDocument)
  }

  async graphqlValidateError () {
    const errors = this.graphql.validate(this.schema, this.invalidDocument)
    if (errors && errors.length > 0) {
      throw errors[0]
    }
    return errors
  }

  async graphqlExecute () {
    if (this._useNamedArgs) {
      return this.graphql.execute({ schema: this.schema, document: this.validDocument })
    }
    return this.graphql.execute(this.schema, this.validDocument)
  }

  async graphqlExecuteError () {
    if (this._useNamedArgs) {
      return this.graphql.execute({ schema: this.schema, document: this.errorDocument })
    }
    return this.graphql.execute(this.schema, this.errorDocument)
  }
}

module.exports = GraphqlTestSetup
