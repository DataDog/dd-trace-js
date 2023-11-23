'use strict'

function vulnerableFind (collection, filter) {
  return collection
    .find(filter)
}

async function vulnerableFindOne (collection, filter) {
  return collection
    .findOne(filter)
}

function vulnerableFindWhere (collection, filter, where) {
  return collection
    .find(filter)
    .where(where)
}

function vulnerableFindExec (collection, filter) {
  return collection
    .find(filter)
    .exec()
}

function vulnerableFindWhereExec (collection, filter, where) {
  return collection
    .find(filter)
    .where(where)
    .exec()
}

module.exports = {
  vulnerableFind,
  vulnerableFindOne,
  vulnerableFindWhere,
  vulnerableFindExec,
  vulnerableFindWhereExec
}
