'use strict'

const swc = require('@swc/core')

async function parseCode () {
  const code = `
    import { useState } from 'react';

    function MyComponent() {
      const [count, setCount] = useState(0);

      const increment = () => {
        setCount(count + 1);
      };

      return 'test';
    }
  `

  try {
    const ast = await swc.parse(code, {
      syntax: 'ecmascript',
      isModule: true,
      comments: false,
    })

    console.log(JSON.stringify(ast, null, 2))
  } catch (error) {
    console.error('Error parsing code:', error)
  }
}

parseCode()
