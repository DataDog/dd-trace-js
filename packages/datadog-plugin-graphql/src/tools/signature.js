/* eslint-disable */
// file mostly untouched from apollo-graphql

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const transforms_1 = require("./transforms");
function defaultEngineReportingSignature(ast, operationName) {
    return transforms_1.printWithReducedWhitespace(transforms_1.sortAST(transforms_1.removeAliases(transforms_1.hideLiterals(transforms_1.dropUnusedDefinitions(ast, operationName)))));
}
exports.defaultEngineReportingSignature = defaultEngineReportingSignature;
