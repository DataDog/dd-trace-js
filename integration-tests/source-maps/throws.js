"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Fastify = require('fastify');
function throwFromTypeScript() {
    throw new Error('boom from typescript');
}
const app = Fastify();
app.get('/', async function handler() {
    throwFromTypeScript();
    return { hello: 'world' };
});
app.listen({ port: Number(process.env.APP_PORT) || 0 }, (error) => {
    if (error)
        throw error;
    const address = app.server.address();
    if (address === null || typeof address === 'string')
        throw new Error('Fastify did not listen on a TCP port');
    process.send?.({ port: address.port });
});
//# sourceMappingURL=throws.js.map
