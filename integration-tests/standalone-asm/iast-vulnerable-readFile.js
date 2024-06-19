const { readFileSync } = require('fs')

function readFile (filename) {
  try {
    // eslint-disable-next-line n/no-path-concat
    return readFileSync(__dirname + '/' + filename).toString()
  } catch (e) {
    // do nothing
  }
}

module.exports = {
  readFile
}
