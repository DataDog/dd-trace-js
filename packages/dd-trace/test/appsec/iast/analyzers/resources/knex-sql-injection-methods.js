'use strict'

function executeKnexRawQuery (knex, sql) {
  return knex.raw(sql)
}

function executeKnexNestedRawQuery (knex, taintedSql, notTaintedSql) {
  return knex.raw(notTaintedSql).then(() => {
    knex.raw(taintedSql)
  })
}

function executeKnexNestedRawQueryOnRejectedInThen (knex, taintedSql, sqlToFail) {
  return knex.raw(sqlToFail).then(
    () => {},
    () => {
      knex.raw(taintedSql)
    }
  )
}

function executeKnexNestedRawQueryWitCatch (knex, taintedSql, sqlToFail) {
  return knex.raw(sqlToFail)
    .then(
      () => {}
    )
    .catch(() => {
      knex.raw(taintedSql)
    })
}

function executeKnexNestedRawQueryAsCallback (knex, taintedSql, sqlToFail, cb) {
  knex.raw(sqlToFail).asCallback(() => {
    knex.raw(taintedSql).asCallback(cb)
  })
}

module.exports = {
  executeKnexRawQuery,
  executeKnexNestedRawQuery,
  executeKnexNestedRawQueryOnRejectedInThen,
  executeKnexNestedRawQueryWitCatch,
  executeKnexNestedRawQueryAsCallback
}
