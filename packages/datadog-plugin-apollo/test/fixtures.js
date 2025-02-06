'use strict'

const typeDefs = `
  type Query {
    hello(name: String, title: String): String
    human: Human
    friends: [Human]
  }

  type Mutation {
    human: Human
  }

  type Subscription {
    human: Human
  }

  type Human {
    name: String
    address: Address
    pets: [Pet]
  }

  type Address {
    civicNumber: String
    street: String
  }

  type Pet {
    type: String
    name: String
    owner: Human
    colours: [Colour]
  }

  type Colour {
    code: String
  }
`

const resolvers = {
  Query: {
    hello: (_, args) => args.name,
    human: () => Promise.resolve({}),
    friends: () => [{ name: 'alice' }, { name: 'bob' }]
  },
  Mutation: {
    human: () => Promise.resolve({ name: 'human name' })
  },
  Subscription: {
    human: () => Promise.resolve({ name: 'human name' })
  },
  Human: {
    name: () => 'test',
    address: () => ({}),
    pets: () => [{}, {}, {}]
  },
  Address: {
    civicNumber: () => '123',
    street: () => 'foo street'
  },
  Pet: {
    type: () => 'dog',
    name: () => 'foo bar',
    owner: () => ({}),
    colours: () => [{}, {}]
  },
  Colour: {
    code: () => '#ffffff'
  }
}

const name = 'accounts'

exports.name = name
exports.typeDefs = typeDefs
exports.url = `https://${name}.api.com.invalid`
exports.resolvers = resolvers
