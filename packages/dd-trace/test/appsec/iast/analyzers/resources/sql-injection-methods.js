'use strict'

function executeQuery (sql, clientOrPool) {
  return clientOrPool.query(sql)
}

function executeQueryWithCallback (sql, clientOrPool, cb) {
  return clientOrPool.query(sql, cb)
}

module.exports = { executeQuery, executeQueryWithCallback }
