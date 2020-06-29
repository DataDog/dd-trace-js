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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5saW5lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2dyZWV0ZXIudHMiLCIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7OztZQUFBO2dCQUFBO2dCQUlBLENBQUM7Z0JBSEMsdUJBQUssR0FBTCxVQUFPLElBQVk7b0JBQ2pCLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBVSxJQUFJLE1BQUcsQ0FBQyxDQUFBO2dCQUNoQyxDQUFDO2dCQUNILGNBQUM7WUFBRCxDQUFDLEFBSkQsSUFJQzs7UUFHRCxDQUFDOzs7Ozs7O0lDSEQsU0FBUyxJQUFJO1FBQ1gsT0FBTyxPQUFPLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFBO0lBQ2xDLENBQUM7Ozs7Ozs7O1lBSkssT0FBTyxHQUFHLElBQUksaUJBQU8sRUFBRSxDQUFBO2lDQU1kLElBQUksRUFBRTtRQUNyQixDQUFDIn0=