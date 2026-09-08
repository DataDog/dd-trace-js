'use strict'
require('./_runner').run('invoke-cohere-multi-output').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
