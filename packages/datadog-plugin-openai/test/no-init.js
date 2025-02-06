#!/usr/bin/env node
'use strict'

/**
 * Due to the complexity of the service initialization required by openai
 * there was a bug where when requiring dd-trace followed by openai
 * would result in an error if dd-trace wasn't first initialized.
 *
 * @see https://github.com/DataDog/dd-trace-js/issues/3357
 */
require(process.env.PATH_TO_DDTRACE)
require(process.env.PATH_TO_OPENAI).get()
