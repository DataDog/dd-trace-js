'use strict'

require(process.argv[2])
if (!global._ddtrace) {
    throw new Error('expected global._ddtrace to exist from ' + process.argv[2])
}
