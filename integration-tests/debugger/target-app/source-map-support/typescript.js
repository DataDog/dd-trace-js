"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require('dd-trace/init');
var node_http_1 = require("node:http");
var world_1 = require("./hello/world");
var server = (0, node_http_1.createServer)(function (req, res) {
    // Blank lines below to ensure line numbers in transpiled file differ from original file
    res.end((0, world_1.sayHello)()); // BREAKPOINT: /
});
server.listen(process.env.APP_PORT || 0, function () {
    var _a;
    (_a = process.send) === null || _a === void 0 ? void 0 : _a.call(process, { port: server.address().port });
});
//# sourceMappingURL=typescript.js.map