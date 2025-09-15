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

async function executeKnexAsyncNestedRawQuery (knex, taintedSql, notTaintedSql) {
  await knex.raw(notTaintedSql)
  await knex.raw(taintedSql)
}

async function executeKnexAsyncNestedRawQueryAsAsyncTryCatch (knex, taintedSql, sqlToFail) {
  try {
    await knex.raw(sqlToFail)
  } catch (e) {
    await knex.raw(taintedSql)
  }
}

module.exports = {
  executeKnexRawQuery,
  executeKnexNestedRawQuery,
  executeKnexAsyncNestedRawQuery,
  executeKnexNestedRawQueryOnRejectedInThen,
  executeKnexNestedRawQueryWitCatch,
  executeKnexNestedRawQueryAsCallback,
  executeKnexAsyncNestedRawQueryAsAsyncTryCatch
}
