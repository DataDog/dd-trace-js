'use strict'

const csiMethods = [
  { src: 'concat' },
  { src: 'join' },
  { src: 'parse' },
  { src: 'plusOperator', operator: true },
  { src: 'random' },
  { src: 'replace' },
  { src: 'slice' },
  { src: 'substr' },
  { src: 'substring' },
  { src: 'toLowerCase', dst: 'stringCase' },
  { src: 'toUpperCase', dst: 'stringCase' },
  { src: 'trim' },
  { src: 'trimEnd' },
  { src: 'trimStart', dst: 'trim' }
]

module.exports = {
  csiMethods
}
