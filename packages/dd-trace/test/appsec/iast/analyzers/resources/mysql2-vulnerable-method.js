'use strict'

module.exports = function vulnerableMethod (connection, sql) {
  return new Promise((resolve, reject) => {
    connection.query(sql, function (err) {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}
