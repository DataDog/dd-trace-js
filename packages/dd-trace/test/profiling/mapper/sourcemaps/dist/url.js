System.register("greeter", [], function (exports_1, context_1) {
    "use strict";
    var Greeter;
    var __moduleName = context_1 && context_1.id;
    return {
        setters: [],
        execute: function () {
            Greeter = /** @class */ (function () {
                function Greeter() {
                }
                Greeter.prototype.greet = function (name) {
                    console.log("Hello, " + name + "!");
                };
                return Greeter;
            }());
            exports_1("Greeter", Greeter);
        }
    };
});
System.register("index", ["greeter"], function (exports_2, context_2) {
    "use strict";
    var greeter_1, greeter;
    var __moduleName = context_2 && context_2.id;
    function main() {
        return greeter.greet('John Doe');
    }
    return {
        setters: [
            function (greeter_1_1) {
                greeter_1 = greeter_1_1;
            }
        ],
        execute: function () {
            greeter = new greeter_1.Greeter();
            exports_2("default", main());
        }
    };
});
//# sourceMappingURL=url.js.map