'use strict'

const swc = require('@swc/core')

async function parseCode () {
  const code = require('fs').readFileSync('./node_modules/express/lib/request.js', 'utf8')
  // const code = `
  //   import { useState } from 'react';

  //   function MyComponent() {
  //     const [count, setCount] = useState(0);

  //     const increment = () => {
  //       setCount(count + 1);
  //     };

  //     return 'test';
  //   }
  // `

  try {
    const ast = await swc.parse(code, {
      syntax: 'ecmascript',
      isModule: false,
      comments: false,
    })

    // console.log(JSON.stringify(ast, null, 2))
  } catch (error) {
    console.error('Error parsing code:', error)
  }
}

parseCode()
