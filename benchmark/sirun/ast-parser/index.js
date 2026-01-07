'use strict'

/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable n/no-extraneous-require */

const {
  PARSE,
  USE_ACORN,
  USE_OXC,
  USE_SWC
} = process.env

const code = `
  const { useState } = require('react');

  function MyComponent() {
    const [count, setCount] = useState(0);

    const increment = () => {
      setCount(count + 1);
    };

    return 'test';
  }
`

if (USE_ACORN === 'true') {
  const { parse } = require('acorn')

  if (PARSE === 'true') {
    parse(code, { ecmaVersion: 2020 })
  }
}

if (USE_OXC === 'true') {
  const { parseSync } = require('oxc-parser')

  if (PARSE === 'true') {
    parseSync('index.js', code)
  }
}

if (USE_SWC === 'true') {
  const { parseSync } = require('@swc/core')

  if (PARSE === 'true') {
    parseSync(code)
  }
}
