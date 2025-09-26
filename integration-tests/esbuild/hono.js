import { tracer } from 'dd-trace';
tracer.init({ logInjection: true, runtimeMetrics: true });


import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { serve } from '@hono/node-server';


const app = new Hono();

function loggerMiddleware() {
  return createMiddleware(async (c, next) => {
    console.info('Incoming request');
  
    await next();
  
    const { status, ok } = c.res;
 
    console.info('Request completed', {
      response: {
        status,
        ok,
      },
    });
  });
}

app.use(loggerMiddleware());

app.get('/', (c) => c.text('Hello World'));

serve({ port: 4000, fetch: app.fetch }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`); // Listening on http://localhost:4000
});
// import tracer from 'dd-trace';
// tracer.init()

// import { createServer } from 'http';

// const server = createServer((req, res) => {
//   res.end('Hello World');
// });

// server.listen(4000, () => {
//   console.log('Listening on http://localhost:4000');
// });