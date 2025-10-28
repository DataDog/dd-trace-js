/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Defines custom error types throwable by the runtime.
 */
'use strict'

class ExtendedError extends Error {
  constructor (reason) {
    const { stackTraceLimit } = Error
    Error.stackTraceLimit = 0
    super(reason)
    Error.stackTraceLimit = stackTraceLimit
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

class ImpendingTimeout extends ExtendedError {}
ImpendingTimeout.prototype.name = 'Impending Timeout'

module.exports = {
  ImpendingTimeout
}
