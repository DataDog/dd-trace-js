// windows.h defines min and max macros.
#define NOMINMAX
#include <algorithm>
#undef min
#undef max
#undef NOMINMAX

#include <stdint.h>
#include <map>
#include <unordered_map>
#include <memory>
#include <sstream>

#include <tdigest/TDigest.h>

#include <napi.h>
#include <uv.h>
#include <v8.h>

using Napi::Array;
using Napi::CallbackInfo;
using Napi::Env;
using Napi::Function;
using Napi::Number;
using Napi::Object;
using Napi::String;
using Napi::Value;

class Histogram {
 public:
  Histogram() { Reset(); }

  void Add(uint64_t value) {
    if (count_ == 0) {
      min_ = max_ = value;
    } else {
      min_ = (std::min)(min_, value);
      max_ = (std::max)(max_, value);
    }

    count_ += 1;
    sum_ += value;

    digest_->add(static_cast<tdigest::Value>(value));
  }

  uint64_t Percentile(double value) {
    return count_ == 0 ? 0 :
        static_cast<uint64_t>(std::round(digest_->quantile(value)));
  }

  void Reset() {
    min_ = 0;
    max_ = 0;
    sum_ = 0;
    count_ = 0;
    digest_ = std::make_shared<tdigest::TDigest>(1000);
  }

  Value ToValue(Env env) {
    auto o = Object::New(env);

    o["min"] = min_;
    o["max"] = max_;
    o["sum"] = sum_;
    o["avg"] = count_ == 0 ? 0 : sum_ / count_;
    o["count"] = count_;
    o["median"] = Percentile(0.50);
    o["p95"] = Percentile(0.95);

    return o;
  }

 private:
  uint64_t min_;
  uint64_t max_;
  uint64_t sum_;
  uint64_t count_;
  std::shared_ptr<tdigest::TDigest> digest_;
};

class Collector {
 public:
  virtual void Start() = 0;
  virtual void Stop() = 0;
  virtual void Dump(Env, Object&) = 0;
};


  ///////////////////
 // GC STATISTICS //
///////////////////
class GCStat : public Collector {
 public:
  GCStat() {
    types_[v8::GCType::kGCTypeScavenge] = "scavenge";
    types_[v8::GCType::kGCTypeMarkSweepCompact] = "mark_sweep_compact";
    types_[v8::GCType::kGCTypeIncrementalMarking] = "incremental_marking";
    types_[v8::GCType::kGCTypeProcessWeakCallbacks] = "process_weak_callbacks";
    types_[v8::GCType::kGCTypeAll] = "all";
  }

  ~GCStat() { Stop(); }

 private:
  static void OnPrologue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
    auto self = reinterpret_cast<GCStat*>(data);
    self->start_time_ = uv_hrtime();
  }

  static void OnEpilogue(v8::Isolate*, v8::GCType type, v8::GCCallbackFlags, void* data) {
    auto self = reinterpret_cast<GCStat*>(data);
    uint64_t usage = uv_hrtime() - self->start_time_;

    if (self->pause_.find(type) == self->pause_.end()) {
      self->pause_[type] = Histogram();
    }

    self->pause_[type].Add(usage);
    self->pause_[v8::GCType::kGCTypeAll].Add(usage);
  }

  void Start() {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    isolate->AddGCPrologueCallback(OnPrologue, this);
    isolate->AddGCEpilogueCallback(OnEpilogue, this);
  }

  void Stop() {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    if (isolate) {
      isolate->RemoveGCPrologueCallback(OnPrologue, this);
      isolate->RemoveGCEpilogueCallback(OnEpilogue, this);
    }
  }

  void Dump(Env env, Object& o) {
    auto gc = Object::New(env);

    for (auto& it : pause_) {
      gc[types_[it.first]] = it.second.ToValue(env);
      it.second.Reset();
    }

    o["gc"] = gc;
  }

  std::map<v8::GCType, Histogram> pause_;
  std::map<v8::GCType, std::string> types_;
  uint64_t start_time_;
};


  ///////////////////////////
 // EVENT LOOP STATISTICS //
///////////////////////////
class EventLoopStat : public Collector {
 public:
  EventLoopStat() {
    uv_prepare_init(uv_default_loop(), &prepare_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&prepare_handle_));
    prepare_handle_.data = reinterpret_cast<void*>(this);

    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));
    check_handle_.data = reinterpret_cast<void*>(this);

    check_time_ = uv_hrtime();
  }

  ~EventLoopStat() { Stop(); }

 private:
  static void OnPrepare(uv_prepare_t* handle) {
    auto self = reinterpret_cast<EventLoopStat*>(handle->data);
    self->prepare_time_ = uv_hrtime();
    self->timeout_ = uv_backend_timeout(uv_default_loop());
  }

  static void OnCheck(uv_check_t* handle) {
    auto self = reinterpret_cast<EventLoopStat*>(handle->data);

    uint64_t check_time = uv_hrtime();
    uint64_t poll_time = check_time - self->prepare_time_;
    uint64_t latency = self->prepare_time_ - self->check_time_;
    uint64_t timeout = self->timeout_ * 1000 * 1000;

    if (poll_time > timeout) {
      latency += poll_time - timeout;
    }

    self->histogram_.Add(latency);
    self->check_time_ = check_time;
  }

  void Start() {
    uv_prepare_start(&prepare_handle_, OnPrepare);
    uv_check_start(&check_handle_, OnCheck);
  }

  void Stop() {
    uv_prepare_stop(&prepare_handle_);
    uv_check_stop(&check_handle_);
    histogram_.Reset();
  }

  void Dump(Env env, Object& o) {
    o["eventLoop"] = histogram_.ToValue(env);
    histogram_.Reset();
  }

  uv_check_t check_handle_;
  uv_prepare_t prepare_handle_;
  uint64_t check_time_;
  uint64_t prepare_time_;
  uint64_t timeout_;
  Histogram histogram_;
};


  /////////////////////
 // HEAP STATISTICS //
/////////////////////
class HeapStat : public Collector {
 public:
  ~HeapStat() { Stop(); }

 private:
  void Start() {}
  void Stop() {}

  void Dump(Env env, Object& o) {
    v8::Isolate* isolate = v8::Isolate::GetCurrent();
    v8::HeapSpaceStatistics stats;

    auto heap = Object::New(env);
    auto spaces = Array::New(env);
    heap["spaces"] = spaces;

    for (size_t i = 0; i < isolate->NumberOfHeapSpaces(); i += 1) {
      v8::HeapSpaceStatistics stats;
      auto space = Object::New(env);
      if (isolate->GetHeapSpaceStatistics(&stats, i)) {
        space["space_name"] = std::string(stats.space_name());
        space["space_size"] = stats.space_size();
        space["space_used_size"] = stats.space_used_size();
        space["space_available_size"] = stats.space_available_size();
        space["physical_space_size"] = stats.physical_space_size();

        spaces[i] = space;
      } else {
        spaces[i] = env.Null();
      }
    }

    o["heap"] = heap;
  }
};

static uint64_t time_to_micro(uv_timeval_t timeval) {
  return timeval.tv_sec * 1000 * 1000 + timeval.tv_usec;
}

class ProcessStat : public Collector {
 public:
  ~ProcessStat() { Stop(); }

 private:
  void Start() {}
  void Stop() {}

  void Dump(Env env, Object& o) {
    uv_rusage_t usage;
    uv_getrusage(&usage);

    auto cpu = Object::New(env);
    cpu["user"] = time_to_micro(usage.ru_utime) - time_to_micro(usage_.ru_utime);
    cpu["system"] = time_to_micro(usage.ru_stime) - time_to_micro(usage_.ru_stime);

    o["cpu"] = cpu;

    usage_ = usage;
  }

  uv_rusage_t usage_;
};


  ///////////////////
 // SPAN TRACKING //
///////////////////
class SpanTracker : public Collector {
 public:
  ~SpanTracker() {
    Stop();
  }

  uint64_t Track(const Object& span) {
    if (!running_) {
      return -1;
    }

    auto context = span["_spanContext"].As<Object>();

    std::string name = context.Get("_name").As<String>();

    auto id = id_counter_;
    id_counter_ += 1;
    handle_finished_[id] = name;

    unfinished_total_ += 1;
    unfinished_[name] += 1;

    auto tracker = this;
    context.AddFinalizer([id, name, tracker](Env, std::string*) {
      if (tracker->handle_finished_.find(id) == tracker->handle_finished_.end()) {
        tracker->finished_total_ -= 1;
        tracker->finished_[name] -= 1;
      } else {
        tracker->unfinished_total_ -= 1;
        tracker->unfinished_[name] -= 1;
      }
    }, &name);

    return id;
  }

  void Finish(uint64_t id) {
    if (!running_) {
      return;
    }

    unfinished_total_ -= 1;
    finished_total_ += 1;

    std::string name = handle_finished_[id];
    handle_finished_.erase(id);

    if (finished_.find(name) == finished_.end()) {
      finished_.insert(std::make_pair(name, 0));
    }

    unfinished_[name] -= 1;
    finished_[name] += 1;
  }

 private:
  void Start() {
    running_ = true;
  }

  void Stop() {
    running_ = false;
    finished_total_ = 0;
    unfinished_total_ = 0;
    finished_.clear();
    unfinished_.clear();
  }

  void Dump(Env env, Object& o) {
    auto spans = Object::New(env);

    auto total = Object::New(env);
    total["finished"] = finished_total_;
    total["unfinished"] = unfinished_total_;

    auto operations = Object::New(env);
    auto finished = Object::New(env);
    auto unfinished = Object::New(env);
    operations["finished"] = finished;
    operations["unfinished"] = unfinished;

    for (auto it : finished_) {
      finished[it.first] = it.second;
    }
    for (auto it : unfinished_) {
      unfinished[it.first] = it.second;
    }

    spans["operations"] = operations;
    spans["total"] = total;

    o["spans"] = spans;
  }

  bool running_ = false;
  std::unordered_map<std::string, uint64_t> unfinished_;
  std::unordered_map<std::string, uint64_t> finished_;
  uint64_t unfinished_total_ = 0;
  uint64_t finished_total_ = 0;

  std::unordered_map<uint64_t, std::string> handle_finished_;
  uint64_t id_counter_ = 0;
};


  //////////////////////
 // STATIC INSTANCES //
//////////////////////

static GCStat gc;
static EventLoopStat ev;
static HeapStat heap;
static ProcessStat process;
static SpanTracker spans;
static Collector* collectors[] = {
    &gc,
    &ev,
    &heap,
    &process,
    &spans,
};


  /////////////////
 // JS BINDINGS //
/////////////////

static Value Start(const CallbackInfo& info) {
  for (auto& c : collectors) {
    c->Start();
  }

  return info.Env().Null();
}

static Value Stop(const CallbackInfo& info) {
  for (auto& c : collectors) {
    c->Stop();
  }

  return info.Env().Null();
}

static Value Dump(const CallbackInfo& info) {
  Env env = info.Env();

  Object o = Object::New(env);

  for (auto& c : collectors) {
    c->Dump(env, o);
  }

  return o;
}

static Value Track(const CallbackInfo& info) {
  uint64_t id = spans.Track(info[0].As<Object>());
  return Number::New(info.Env(), static_cast<double>(id));
}

static Value Finish(const CallbackInfo& info) {
  double id = info[0].As<Number>();
  spans.Finish(static_cast<uint64_t>(id));
  return info.Env().Null();
}

Object Init(Env env, Object exports) {
  exports["start"] = Function::New(env, Start);
  exports["stop"] = Function::New(env, Stop);
  exports["dump"] = Function::New(env, Dump);
  exports["track"] = Function::New(env, Track);
  exports["finish"] = Function::New(env, Finish);

  return exports;
}

NODE_API_MODULE(metrics, Init)
