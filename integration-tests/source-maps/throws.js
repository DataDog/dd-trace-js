"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http = require('node:http');
const tracer = require('dd-trace');
function throwFromTypeScript() {
    throw new Error('boom from typescript');
}
const server = http.createServer((request, response) => {
    if (request.url === '/stack') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ stack: getApplicationStack() }));
        return;
    }
    try {
        throwFromTypeScript();
    }
    catch (error) {
        if (!(error instanceof Error))
            throw error;
        tracer.trace('source-map.request', (span) => {
            span.setTag('error', error);
        });
        response.statusCode = 500;
        response.end();
    }
});
function getApplicationStack() {
    try {
        throwFromTypeScript();
    }
    catch (error) {
        if (!(error instanceof Error))
            throw error;
        return error.stack;
    }
}
server.listen(Number(process.env.APP_PORT) || 0, () => {
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('HTTP server did not listen on a TCP port');
    process.send?.({ port: address.port });
});
//# sourceMappingURL=throws.js.map
