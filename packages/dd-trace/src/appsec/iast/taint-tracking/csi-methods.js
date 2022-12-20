'use strict'

const csiMethods = [
  { src: 'plusOperator', operator: true },
  { src: 'trim' },
  { src: 'trimStart', dst: 'trim' },
  { src: 'trimEnd' },
  { src: 'concat' }
]

module.exports = {
  csiMethods
}
