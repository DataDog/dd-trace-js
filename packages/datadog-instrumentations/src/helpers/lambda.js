'use strict'

const path = require('path')

exports.extractModuleRootAndHandler = function extractModuleRootAndHandler (fullHandler) {
  const handlerString = path.basename(fullHandler)
  const moduleRoot = fullHandler.substring(0, fullHandler.indexOf(handlerString))

  return [moduleRoot, handlerString]
}

exports.splitHandlerString = function splitHandlerString (handler) {
  const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
  const match = handler.match(FUNCTION_EXPR)
  if (!match || match.length != 3) {
    // Bad handler
    return
  }
  return [match[1], match[2]] // [module, function-path]
}