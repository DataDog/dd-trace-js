#include "Object.hpp"

namespace datadog {
  Object::Object() {
    target_ = Nan::New<v8::Object>();
  }

  Object::Object(v8::Local<v8::Object> target) {
    target_ = target;
  }

  void Object::set(std::string key, std::string value) {
    Nan::Set(
      target_,
      Nan::New(key).ToLocalChecked(),
      Nan::New(value).ToLocalChecked()
    );
  }

  void Object::set(std::string key, uint64_t value) {
    Nan::Set(
      target_,
      Nan::New(key).ToLocalChecked(),
      Nan::New<v8::Number>(value)
    );
  }

  void Object::set(std::string key, v8::Local<v8::Object> value) {
    Nan::Set(
      target_,
      Nan::New(key).ToLocalChecked(),
      value
    );
  }

  void Object::set(std::string key, Nan::FunctionCallback value) {
    Nan::Set(
      target_,
      Nan::New(key).ToLocalChecked(),
      Nan::GetFunction(Nan::New<v8::FunctionTemplate>(value)).ToLocalChecked()
    );
  }

  v8::Local<v8::Object> Object::to_json() {
    return target_;
  }
}
