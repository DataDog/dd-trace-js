'use strict'

// non default name so that it only gets picked up intentionally
module.exports = {
  exclude: ['node_modules/**'],
  include: process.env.NYC_INCLUDE ? JSON.parse(process.env.NYC_INCLUDE) : ['ci-visibility/test/**']
}
