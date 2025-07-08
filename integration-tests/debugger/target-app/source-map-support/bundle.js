var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// integration-tests/debugger/target-app/source-map-support/hello/world.js
var require_world = __commonJS({
  "integration-tests/debugger/target-app/source-map-support/hello/world.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.sayHello = sayHello2;
    function sayHello2() {
      return "hello world";
    }
  }
});

// integration-tests/debugger/target-app/source-map-support/typescript.ts
var import_node_http = require("node:http");
var import_world = __toESM(require_world());
require("dd-trace/init");
var server = (0, import_node_http.createServer)((req, res) => {
  res.end((0, import_world.sayHello)());
});
server.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port });
});
//# sourceMappingURL=bundle.js.map
