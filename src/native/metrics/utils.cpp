#include "utils.hpp"

namespace datadog {
  std::string to_string(v8::Isolate *isolate, v8::Local<v8::Value> handle) {
    #if NODE_MODULE_VERSION >= NODE_8_0_MODULE_VERSION
    return *v8::String::Utf8Value(isolate, handle);
    #else
    return *v8::String::Utf8Value(handle));
    #endif
  }
}
