/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Defines custom error types throwable by the runtime.
 */
'use strict'

function isError (obj) {
  return (
    obj &&
    obj.name &&
    obj.message &&
    obj.stack &&
    typeof obj.name === 'string' &&
    typeof obj.message === 'string' &&
    typeof obj.stack === 'string'
  )
}

class ExtendedError extends Error {
  constructor(reason) {
    super(reason)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

class ImportModuleError extends ExtendedError {}
class HandlerNotFound extends ExtendedError {}
class MalformedHandlerName extends ExtendedError {}
class Timeout extends ExtendedError {}

const errorClasses = [
  ImportModuleError,
  HandlerNotFound,
  MalformedHandlerName,
  Timeout
]

errorClasses.forEach((e) => e.prototype.name = `Runtime.${e.name}`)

module.exports = {
  ImportModuleError,
  HandlerNotFound,
  MalformedHandlerName,
  Timeout
}