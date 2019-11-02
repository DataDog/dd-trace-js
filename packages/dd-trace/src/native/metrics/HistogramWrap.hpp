#pragma once

#include <nan.h>

#include "Histogram.hpp"

namespace datadog {
  class HistogramWrap : public Nan::ObjectWrap {
    public:
      static NAN_MODULE_INIT(init) {
        v8::Local<v8::FunctionTemplate> tpl = Nan::New<v8::FunctionTemplate>(factory);
        tpl->SetClassName(Nan::New("HistogramWrap").ToLocalChecked());
        tpl->InstanceTemplate()->SetInternalFieldCount(1);

        Nan::SetPrototypeMethod(tpl, "add", add);
        Nan::SetPrototypeMethod(tpl, "reset", reset);
        Nan::SetPrototypeMethod(tpl, "min", min);
        Nan::SetPrototypeMethod(tpl, "max", max);
        Nan::SetPrototypeMethod(tpl, "sum", sum);
        Nan::SetPrototypeMethod(tpl, "avg", avg);
        Nan::SetPrototypeMethod(tpl, "median", median);
        Nan::SetPrototypeMethod(tpl, "count", count);
        Nan::SetPrototypeMethod(tpl, "percentile", percentile);

        constructor().Reset(Nan::GetFunction(tpl).ToLocalChecked());
      }

      static NAN_METHOD(create) {
        v8::Local<v8::Function> cons = Nan::New(constructor());
        info.GetReturnValue().Set(Nan::NewInstance(cons).ToLocalChecked());
      }

    private:
      explicit HistogramWrap() {}
      ~HistogramWrap() {}

      static NAN_METHOD(factory) {
        if (info.IsConstructCall()) {
          HistogramWrap *obj = new HistogramWrap();
          obj->Wrap(info.This());
          info.GetReturnValue().Set(info.This());
        } else {
          v8::Local<v8::Function> cons = Nan::New(constructor());
          info.GetReturnValue().Set(Nan::NewInstance(cons).ToLocalChecked());
        }
      }

      static NAN_METHOD(add) {
        unwrap(info).add(get(info));
      }

      static NAN_METHOD(min) {
        set(info, unwrap(info).min());
      }

      static NAN_METHOD(max) {
        set(info, unwrap(info).max());
      }

      static NAN_METHOD(sum) {
        set(info, unwrap(info).sum());
      }

      static NAN_METHOD(avg) {
        set(info, unwrap(info).avg());
      }

      static NAN_METHOD(median) {
        set(info, unwrap(info).percentile(0.5));
      }

      static NAN_METHOD(count) {
        set(info, unwrap(info).count());
      }

      static NAN_METHOD(percentile) {
        set(info, unwrap(info).percentile(get(info)));
      }

      static NAN_METHOD(reset) {
        unwrap(info).reset();
      }

      static Histogram& unwrap (Nan::NAN_METHOD_ARGS_TYPE info) {
        return Nan::ObjectWrap::Unwrap<HistogramWrap>(info.Holder())->histogram_;
      }

      static uint64_t get (Nan::NAN_METHOD_ARGS_TYPE info) {
        return Nan::To<double>(v8::Local<v8::Object>::Cast(info[0])).FromJust();
      }

      static void set (Nan::NAN_METHOD_ARGS_TYPE info, uint64_t value) {
        info.GetReturnValue().Set(
          Nan::New<v8::Number>(static_cast<double>(value)));
      }

      static inline Nan::Persistent<v8::Function> & constructor() {
        static Nan::Persistent<v8::Function> cons;
        return cons;
      }

      Histogram histogram_;
  };
}
