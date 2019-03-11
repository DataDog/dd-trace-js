#include <nan.h>

#include "Collector.hpp"
#include "EventLoop.hpp"
#include "GarbageCollection.hpp"
#include "Object.hpp"
#include "Process.hpp"

namespace datadog {
  Collector* eventLoop = new EventLoop();
  Collector* gc = new GarbageCollection();
  Collector* process = new Process();

  static NAN_METHOD(start) {
    eventLoop->enable();
    gc->enable();
    process->enable();
  }

  static NAN_METHOD(stop) {
    eventLoop->disable();
    gc->disable();
    process->disable();
  }

  static NAN_METHOD(stats) {
    Object obj;

    eventLoop->inject(obj);
    gc->inject(obj);
    process->inject(obj);

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
