"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-ignore
const dd_trace_1 = require("dd-trace");
const assert = require("assert");
const llmobs = dd_trace_1.default.llmobs;
class Test {
    runChain(input) {
        llmobs.annotate({
            inputData: 'this is a',
            outputData: 'test'
        });
        return 'world';
    }
}
__decorate([
    llmobs.decorate({ kind: 'agent' })
], Test.prototype, "runChain", null);
const test = new Test();
assert.equal(test.runChain('hello'), 'world');
