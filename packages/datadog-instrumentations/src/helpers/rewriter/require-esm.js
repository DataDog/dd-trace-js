'use strict'

// Synchronous loader hooks rewrite ES modules on this thread after Node reads them, require(esm)
// included. The read-time rewrite in ./loader.js then has to stand down or it instruments twice.
let readRewriteEnabled = true

function disableReadRewrite () {
  readRewriteEnabled = false
}

function isReadRewriteEnabled () {
  return readRewriteEnabled
}

module.exports = { disableReadRewrite, isReadRewriteEnabled }
