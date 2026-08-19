'use strict'

const { exitTags } = require('../../../../datadog-code-origin')

const addExitCodeOrigin = Symbol('integration.pipeline.add_exit_code_origin')

const exitCodeOrigin = {
  name: 'exit-code-origin',
  requires: ['tracing'],
  start (frame) {
    frame[addExitCodeOrigin](exitTags, exitCodeOrigin.start)
  },
}

module.exports = { addExitCodeOrigin, exitCodeOrigin }
