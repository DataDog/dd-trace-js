#include "SpanTracker.hpp"
#include "utils.hpp"

namespace datadog {
  void SpanTracker::inject(Object carrier) {
    Object spans;
    Object total;

    total.set("finished", finished_total_);
    total.set("unfinished", unfinished_total_);

    Object operations;
    Object finished;
    Object unfinished;

    for (auto it : finished_) {
      finished.set(it.first, it.second);
    }

    for (auto it : unfinished_) {
      unfinished.set(it.first, it.second);
    }

    operations.set("finished", finished);
    operations.set("unfinished", unfinished);

    spans.set("operations", operations);
    spans.set("total", total);

    carrier.set("spans", spans);
  };

  void SpanTracker::enable() {
    enabled_ = true;
  }

  void SpanTracker::disable() {
    enabled_ = false;
    finished_total_ = 0;
    unfinished_total_ = 0;
    finished_.clear();
    unfinished_.clear();
  }

  SpanHandle* SpanTracker::track(const v8::Local<v8::Object> &span) {
    if (!enabled_) return nullptr;

    v8::Isolate *isolate = v8::Isolate::GetCurrent();
    v8::Local<v8::Object> context = v8::Local<v8::Object>::Cast(value(span, "_spanContext"));

    ++unfinished_total_;

    SpanHandle *handle = new SpanHandle();

    handle->tracker = this;
    handle->context = new v8::Persistent<v8::Object>(isolate, context);

    std::string name = to_string(value(context, "_name"));

    if (unfinished_.find(name) == unfinished_.end()) {
      unfinished_.insert(std::make_pair(name, 0));
    }

    ++unfinished_[name];

    handle->name = name;
    handle->context->SetWeak(handle, callback, v8::WeakCallbackType::kParameter);

    return handle;
  }

  void SpanTracker::finish(SpanHandle *handle) {
    if (!enabled_) return;

    handle->finished = true;

    --unfinished_total_;
    ++finished_total_;

    std::string name = handle->name;

    if (finished_.find(name) == finished_.end()) {
      finished_.insert(std::make_pair(name, 0));
    }

    --unfinished_[name];
    ++finished_[name];
  }

  void SpanTracker::callback(const v8::WeakCallbackInfo<SpanHandle> &data) {
    SpanHandle *handle = data.GetParameter();

    if (handle->finished) {
      --handle->tracker->finished_total_;
    } else {
      --handle->tracker->unfinished_total_;
    }

    handle->context->Reset();

    if (handle->finished) {
      --handle->tracker->finished_[handle->name];
    } else {
      --handle->tracker->unfinished_[handle->name];
    }

    delete handle->context;
    delete handle;
  }
}
