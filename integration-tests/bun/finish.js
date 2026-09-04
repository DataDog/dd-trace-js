'use strict'

function finish () {
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log('ok')
    process.exit(0)
  }, 300)
}

module.exports = finish
