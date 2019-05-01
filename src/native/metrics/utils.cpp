#include <nan.h>

#include "utils.hpp"

namespace datadog {
  std::string to_string(v8::Local<v8::Value> handle) {
    return *Nan::Utf8String(handle);
  }

  v8::Local<v8::String> from_string(std::string str) {
    return Nan::New(str).ToLocalChecked();
  }

  template <class T> v8::Local<T> value(v8::Local<v8::Object> obj, std::string key) {
    return Nan::To<T>(Nan::Get(obj, from_string(key)).ToLocalChecked());
  }
}
