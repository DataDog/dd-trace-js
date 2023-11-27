const axios = require('axios')

const schema = `type Book {
  title: String,
  author: String
}

type Query {
    books(title: String): [Book!]!
}
`
const query = `
query GetBooks ($title: String) {
  books(title: $title) {
    title,
    author
  }
}`
const books = [
  {
    title: 'Test title',
    author: 'Test author'
  }
]

const resolvers = {
  Query: {
    books: (root, args, context) => {
      return books.filter(book => {
        return book.title.includes(args.title)
      })
    }
  }
}

async function makeGraphqlRequest (port, variables) {
  const headers = {
    'content-type': 'application/json'
  }
  return axios.post(`http://localhost:${port}/graphql`, {
    operationName: 'GetBooks',
    query,
    variables
  }, { headers })
}
module.exports = {
  books,
  schema,
  query,
  resolvers,
  makeGraphqlRequest
}
