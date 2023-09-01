'use strict'

function executeQuery (sql, clientOrPool) {
  return clientOrPool.query(sql)
}

function executeQueryWithCallback (sql, clientOrPool, cb) {
  return clientOrPool.query(sql, cb)
}

function executeKnexRawQuery (knex, sql) {
  return knex.raw(sql)
}

module.exports = { executeQuery, executeQueryWithCallback, executeKnexRawQuery }
