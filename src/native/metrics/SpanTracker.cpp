#include "SpanTracker.hpp"

namespace datadog {
  void SpanTracker::inject(Object carrier) {
    Object spans;

    spans.set("total", total_);

    if (debug_) {
      Object operations;

      for (auto it = spans_.begin(); it != spans_.end(); ++it) {
        operations.set(it->first, it->second);
      }

      spans.set("operations", operations);
    }

    carrier.set("spans", spans);
  };

  void SpanTracker::enable(bool debug) {
    enabled_ = true;
    debug_ = debug;
  }

  void SpanTracker::disable() {
    enabled_ = false;
  }

  void SpanTracker::track(const v8::Local<v8::Object> &span) {
    if (!enabled_) return;

    v8::Isolate *isolate = v8::Isolate::GetCurrent();

    ++total_;

    SpanHandle *handle = new SpanHandle();

    handle->tracker = this;
    handle->span = new v8::Persistent<v8::Object>(isolate, span);

    if (debug_) {
      v8::Local<v8::String> context_key = v8::String::NewFromUtf8(isolate, "_spanContext");
      v8::Local<v8::String> name_key = v8::String::NewFromUtf8(isolate, "_name");
      v8::Local<v8::Object> context = v8::Local<v8::Object>::Cast(span->Get(context_key));
      std::string name(*v8::String::Utf8Value(isolate, context->Get(name_key)));

      if (auto it = spans_.find(name) == spans_.end()) {
        spans_.insert(std::make_pair(name, 0));
      }

      ++spans_[name];

      handle->name = name;
    }

    handle->span->SetWeak(handle, callback, v8::WeakCallbackType::kParameter);
  };

  void SpanTracker::callback(const v8::WeakCallbackInfo<SpanHandle> &data) {
    SpanHandle *handle = data.GetParameter();

    --handle->tracker->total_;

    handle->span->Reset();

    if (handle->tracker->debug_) {
      --handle->tracker->spans_[handle->name];
    }

    delete handle->span;
    delete handle;
  }
}
