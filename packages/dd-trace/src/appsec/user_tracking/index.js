'use strict'

let collectionMode

function setCollectionMode (mode) {
  switch (mode) {
    case 'ident':
    case 'identification':
      collectionMode = 'ident'
      break
    case 'anon':
    case 'anonymization':
      collectionMode = 'anon'
      break
    default:
      collectionMode = null // disabled
  }
}

module.exports = {
  setCollectionMode
}
