// this file intentionally empty for bundlers that end up including dd-trace-js
// when building for browsers, this file should only be gotten to by the
// "exports" field of package.json, if you are in the browser and see this
// file, it likely means something imported dd-trace-js accidentally.
// dd-trace-js does not currently support running inside of browsers.

// a minimal shim is here to avoid errors if people do manage to
// import dd-trace-js improperly but it should avoid errors.
exports.default = exports;
exports.init = ({
    init() {}
}).init;
