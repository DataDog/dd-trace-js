'use strict'

const csiMethods = [
  { src: 'concat' },
  { src: 'plusOperator', operator: true },
  { src: 'random' },
  { src: 'replace' },
  { src: 'slice' },
  { src: 'substr' },
  { src: 'substring' },
  { src: 'trim' },
  { src: 'trimEnd' },
  { src: 'trimStart', dst: 'trim' },
  { src: 'parse' }
]

module.exports = {
  csiMethods
}
