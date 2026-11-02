'use strict'

const assert = require('node:assert/strict')

/* eslint-disable n/no-missing-require -- useSandbox installs these dependencies. */
const { nanoid } = require('nanoid')
const axios = require('axios')

assert.strictEqual(nanoid(10).length, 10)
assert.strictEqual(typeof axios.get, 'function')
