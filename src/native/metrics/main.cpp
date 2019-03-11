#include <nan.h>

#include "Collector.hpp"
#include "EventLoop.hpp"
#include "GarbageCollection.hpp"
#include "Object.hpp"
#include "Process.hpp"

namespace datadog {
  EventLoop eventLoop;
  GarbageCollection gc;
  Process process;

  NAN_GC_CALLBACK(before_gc) {
    gc.before(type);
  }

  NAN_GC_CALLBACK(after_gc) {
    gc.after(type);
  }

  NAN_METHOD(start) {
    eventLoop.enable();

    Nan::AddGCPrologueCallback(before_gc);
    Nan::AddGCEpilogueCallback(after_gc);
  }

  NAN_METHOD(stop) {
    eventLoop.disable();

    Nan::RemoveGCPrologueCallback(before_gc);
    Nan::RemoveGCEpilogueCallback(after_gc);
  }

  NAN_METHOD(stats) {
    Object obj;

    eventLoop.inject(obj);
    gc.inject(obj);
    process.inject(obj);

    info.GetReturnValue().Set(obj.to_json());
  }

  NAN_MODULE_INIT(init) {
    Object obj = Object(target);

    obj.set("start", start);
    obj.set("stop", stop);
    obj.set("stats", stats);
  }

  NODE_MODULE(metrics, init);
}
