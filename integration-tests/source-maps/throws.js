"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
function throwFromTypeScript() {
    throw new Error('boom from typescript');
}
const app = (0, fastify_1.default)();
app.get('/', async function handler() {
    throwFromTypeScript();
    return { hello: 'world' };
});
app.listen({ port: process.env.APP_PORT || 0 }, (error) => {
    if (error)
        throw error;
    process.send?.({ port: app.server.address().port });
});
//# sourceMappingURL=throws.js.map
