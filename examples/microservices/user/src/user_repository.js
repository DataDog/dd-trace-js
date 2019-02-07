'use strict'

const db = require('./db')
const users = [
  {
    _id: 'alice',
    name: 'Alice',
    age: 25
  },
  {
    _id: 'bob',
    name: 'Bob',
    age: 30
  }
]

db.collection('users').then(col => {
  const operations = users.map(user => ({
    updateOne: {
      filter: { _id: user._id },
      update: { $set: user },
      upsert: true
    }
  }))

  col.bulkWrite(operations)
})

const userRepository = {
  all () {
    return db.collection('users')
      .then(col => col.find({}).toArray())
  }
}

module.exports = userRepository
