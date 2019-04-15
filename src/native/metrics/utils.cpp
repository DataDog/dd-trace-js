#include <nan.h>

#include "utils.hpp"

namespace datadog {
  std::string to_string(v8::Local<v8::Value> handle) {
    return *Nan::Utf8String(handle);
  }
}
