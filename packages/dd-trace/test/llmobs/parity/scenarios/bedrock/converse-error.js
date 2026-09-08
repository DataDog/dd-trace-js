'use strict'
require('./_runner').run('converse-error').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
