'use strict'

const csiMethods = [
  { src: 'plusOperator', operator: true },
  { src: 'trim' },
  { src: 'trimStart', dst: 'trim' },
  { src: 'trimEnd' },
  { src: 'concat' },
  { src: 'substring' },
  { src: 'substr' },
  { src: 'slice' },
  { src: 'replace' }
]

module.exports = {
  csiMethods
}
