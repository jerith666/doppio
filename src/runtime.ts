import gLong = module('./gLong');
import util = module('./util');
import logging = module('./logging');
import exceptions = module('./exceptions');
import java_object = module('./java_object');
import JVM = module('./jvm');
import methods = module('./methods');
import ClassData = module('./ClassData');
import ClassLoader = module('./ClassLoader');

declare var node, UNSAFE;
declare var setImmediate: (cb: (any)=>any)=>void
var vtrace = logging.vtrace;
var trace = logging.trace;
var debug = logging.debug;
var error = logging.error;
var YieldIOException = exceptions.YieldIOException;
var ReturnException = exceptions.ReturnException;
var JavaException = exceptions.JavaException;
var JavaObject = java_object.JavaObject;
var JavaArray = java_object.JavaArray;
var JavaThreadObject = java_object.JavaThreadObject;
var thread_name = java_object.thread_name;
var process = typeof node !== "undefined" ? node.process : global.process;

export interface StackFrameSnapshot {
  name: string;
  pc: number;
  native: bool;
  loader: ClassLoader.ClassLoader;
  stack: any[];
  locals: any[];
}

export class CallStack {
  private _cs: StackFrame[]

  constructor(initial_stack?: any[]) {
    this._cs = [StackFrame.native_frame('$bootstrap')];
    if (initial_stack != null) {
      this._cs[0].stack = initial_stack;
    }
  }

  public snap(): { serialize: () => StackFrameSnapshot[]} {
    var frame: StackFrame, snapshots: {serialize: ()=>StackFrameSnapshot}[], visited;

    visited = {};
    snapshots = (function () {
      var _i, _len, _ref5, _results;

      _ref5 = this._cs;
      _results = [];
      for (_i = 0, _len = _ref5.length; _i < _len; _i++) {
        frame = _ref5[_i];
        _results.push(frame.snap(visited));
      }
      return _results;
    }).call(this);
    return {
      serialize: function () {
        var ss: { serialize: () => StackFrameSnapshot }, _i, _len, _results;

        _results = [];
        for (_i = 0, _len = snapshots.length; _i < _len; _i++) {
          ss = snapshots[_i];
          _results.push(ss.serialize());
        }
        return _results;
      }
    };
  }

  public length(): number {
    return this._cs.length;
  }

  public push(sf): number {
    return this._cs.push(sf);
  }

  public pop(): StackFrame {
    return this._cs.pop();
  }

  public pop_n(n: number): number {
    return this._cs.length -= n;
  }

  public curr_frame(): StackFrame {
    return util.last(this._cs);
  }

  public get_caller(frames_to_skip: number): StackFrame {
    return this._cs[this._cs.length - 1 - frames_to_skip];
  }
}

export class StackFrame {
  public method: methods.Method;
  public locals: any[];
  public stack: any[];
  public pc: number;
  public runner: (any) => any;
  private native: boolean;
  public name: string;

  // XXX: Super kludge: DO NOT USE. Used by the ClassLoader on native frames.
  // We should... remove this...
  public cdata: ClassData.ClassData;
  
  // Used by Native Frames
  public error: (any)=>any

  constructor(method: methods.Method, locals: any[], stack: any[]) {
    this.method = method;
    this.locals = locals;
    this.stack = stack;
    this.pc = 0;
    this.runner = null;
    this.native = false;
    this.name = this.method.full_signature();
  }

  public snap(visited: {[name:string]:bool}): { serialize: () => StackFrameSnapshot } {
    var rv,
      _this = this;

    rv = {
      name: this.name,
      pc: this.pc,
      native: this.native
    };
    return {
      serialize: function () {
        var obj, _ref5;

        rv.loader = (_ref5 = _this.method.cls) != null ? _ref5.loader.serialize(visited) : void 0;
        rv.stack = (function () {
          var _i, _len, _ref6, _ref7, _results;

          _ref6 = this.stack;
          _results = [];
          for (_i = 0, _len = _ref6.length; _i < _len; _i++) {
            obj = _ref6[_i];
            _results.push((_ref7 = obj != null ? typeof obj.serialize === "function" ? obj.serialize(visited) : void 0 : void 0) != null ? _ref7 : obj);
          }
          return _results;
        }).call(_this);
        rv.locals = (function () {
          var _i, _len, _ref6, _ref7, _results;

          _ref6 = this.locals;
          _results = [];
          for (_i = 0, _len = _ref6.length; _i < _len; _i++) {
            obj = _ref6[_i];
            _results.push((_ref7 = obj != null ? typeof obj.serialize === "function" ? obj.serialize(visited) : void 0 : void 0) != null ? _ref7 : obj);
          }
          return _results;
        }).call(_this);
        return rv;
      }
    };
  }

  public static native_frame(name: string, handler?: (any)=>any, error_handler?:(any)=>any): StackFrame {
    var sf;

    // XXX: Super kludge!
    sf = new StackFrame(<methods.Method>{
      full_signature: function () {
        return name;
      }
    }, [], []);
    sf.runner = handler;
    sf.name = name;
    if (error_handler != null) {
      sf.error = error_handler;
    }
    sf.native = true;
    return sf;
  }
}

var run_count = 0;
export class RuntimeState {
  private print: (string) => any;
  private _async_input: (cb: (string) => any) => any;
  private bcl: ClassLoader.BootstrapClassLoader;
  private input_buffer: number[];
  private startup_time: gLong;
  public run_stamp: number;
  private mem_start_addrs: number[];
  private mem_blocks: any;
  public high_oref: number;
  private string_pool: util.SafeMap;
  public lock_refs: any;
  public lock_counts: any;
  public waiting_threads: any;
  private thread_pool: java_object.JavaThreadObject[];
  public curr_thread: java_object.JavaThreadObject;
  private max_m_count: number;
  public unusual_termination: boolean;
  public stashed_done_cb: (any) => any;
  public should_return: bool;
  public system_initialized: bool;

  constructor(print: (string) => any, _async_input: (cb: (string) => any) => any, bcl: ClassLoader.BootstrapClassLoader) {
    this.print = print;
    this._async_input = _async_input;
    this.bcl = bcl;
    this.input_buffer = [];
    this.bcl.reset();
    this.startup_time = gLong.fromNumber((new Date()).getTime());
    this.run_stamp = ++run_count;
    this.mem_start_addrs = [1];
    this.mem_blocks = {};
    this.high_oref = 1;
    this.string_pool = new util.SafeMap;
    this.lock_refs = {};
    this.lock_counts = {};
    this.waiting_threads = {};
    this.thread_pool = [];
    
    var ct = new JavaThreadObject(this);
    this.curr_thread = ct;
    this.max_m_count = 100000;
  }

  public get_bs_cl(): ClassLoader.BootstrapClassLoader {
    return this.bcl;
  }

  public get_bs_class(type: string, handle_null?: boolean): any {
    if (handle_null == null) {
      handle_null = false;
    }
    return this.bcl.get_initialized_class(type, handle_null);
  }

  public get_class(type: string, handle_null?: boolean): any {
    if (handle_null == null) {
      handle_null = false;
    }
    return this.curr_frame().method.cls.loader.get_initialized_class(type, handle_null);
  }

  public get_cl(): ClassLoader.ClassLoader {
    return this.curr_frame().method.cls.loader;
  }

  public preinitialize_core_classes(resume_cb: () => any, except_cb: (cb: () => any) => any): void {
    var core_classes, i, init_next_core_class,
      _this = this;

    core_classes = ['Ljava/lang/Class;', 'Ljava/lang/ClassLoader;', 'Ljava/lang/String;', 'Ljava/lang/Error;', 'Ljava/lang/StackTraceElement;', 'Ljava/io/ExpiringCache;', 'Ljava/io/FileDescriptor;', 'Ljava/io/FileNotFoundException;', 'Ljava/io/IOException;', 'Ljava/io/Serializable;', 'Ljava/io/UnixFileSystem;', 'Ljava/lang/ArithmeticException;', 'Ljava/lang/ArrayIndexOutOfBoundsException;', 'Ljava/lang/ArrayStoreException;', 'Ljava/lang/ClassCastException;', 'Ljava/lang/ClassNotFoundException;', 'Ljava/lang/NoClassDefFoundError;', 'Ljava/lang/Cloneable;', 'Ljava/lang/ExceptionInInitializerError;', 'Ljava/lang/IllegalMonitorStateException;', 'Ljava/lang/InterruptedException;', 'Ljava/lang/NegativeArraySizeException;', 'Ljava/lang/NoSuchFieldError;', 'Ljava/lang/NoSuchMethodError;', 'Ljava/lang/NullPointerException;', 'Ljava/lang/reflect/Constructor;', 'Ljava/lang/reflect/Field;', 'Ljava/lang/reflect/Method;', 'Ljava/lang/System;', 'Ljava/lang/Thread;', 'Ljava/lang/ThreadGroup;', 'Ljava/lang/Throwable;', 'Ljava/lang/UnsatisfiedLinkError;', 'Ljava/nio/ByteOrder;', 'Lsun/misc/VM;', 'Lsun/reflect/ConstantPool;', 'Ljava/lang/Byte;', 'Ljava/lang/Character;', 'Ljava/lang/Double;', 'Ljava/lang/Float;', 'Ljava/lang/Integer;', 'Ljava/lang/Long;', 'Ljava/lang/Short;', 'Ljava/lang/Boolean;', '[Lsun/management/MemoryManagerImpl;', '[Lsun/management/MemoryPoolImpl;'];
    i = -1;
    init_next_core_class = function () {
      trace("init_next_core_class");
      i++;
      if (i < core_classes.length) {
        trace("Initializing " + core_classes[i]);
        _this.bcl.initialize_class(_this, core_classes[i], init_next_core_class, except_cb);
      } else {
        trace("Preinitialization complete.");
        resume_cb();
      }
    };
    init_next_core_class();
  }

  public init_threads(): void {
    var group, my_sf,
      _this = this;

    my_sf = this.curr_frame();
    this.push((group = new JavaObject(this, this.get_bs_class('Ljava/lang/ThreadGroup;'))));
    this.get_bs_class('Ljava/lang/ThreadGroup;').method_lookup(this, '<init>()V').setup_stack(this);
    my_sf.runner = function () {
      var ct;

      ct = null;
      my_sf.runner = function () {
        my_sf.runner = null;
        ct.$meta_stack = _this.meta_stack();
        _this.curr_thread = ct;
        _this.curr_thread.$isAlive = true;
        _this.thread_pool.push(_this.curr_thread);
        _this.get_bs_class('Ljava/lang/Thread;').static_fields.threadInitNumber = 1;
        return debug("### finished thread init ###");
      };
      ct = new JavaObject(_this, _this.get_bs_class('Ljava/lang/Thread;'), {
        'Ljava/lang/Thread;name': _this.init_carr('main'),
        'Ljava/lang/Thread;priority': 1,
        'Ljava/lang/Thread;group': group,
        'Ljava/lang/Thread;threadLocals': null
      });
    };
  }

  public meta_stack(): CallStack {
    return this.curr_thread.$meta_stack;
  }

  public java_throw(cls: ClassData.ReferenceClassData, msg: string): void {
    var my_sf, v,
      _this = this;

    v = new JavaObject(this, cls);
    this.push_array([v, v, this.init_string(msg)]);
    my_sf = this.curr_frame();
    cls.method_lookup(this, '<init>(Ljava/lang/String;)V').setup_stack(this);
    my_sf.runner = function () {
      if (my_sf.method.has_bytecode) {
        my_sf.runner = (function () {
          return my_sf.method.run_bytecode(_this);
        });
      } else {
        my_sf.runner = null;
      }
      throw new JavaException(_this.pop());
    };
    throw ReturnException;
  }

  public init_system_class(): void {
    var my_sf;
    var _this = this;

    my_sf = this.curr_frame();
    this.get_bs_class('Ljava/lang/System;').get_method('initializeSystemClass()V').setup_stack(this);
    my_sf.runner = function () {
      my_sf.runner = null;
      _this.system_initialized = true;
      debug("### finished system class initialization ###");
    };
  }

  public init_args(initial_args: any[]): void {
    var a, args;

    args = new JavaArray(this, this.get_bs_class('[Ljava/lang/String;'), (function () {
      var _i, _len, _results;

      _results = [];
      for (_i = 0, _len = initial_args.length; _i < _len; _i++) {
        a = initial_args[_i];
        _results.push(this.init_string(a));
      }
      return _results;
    }).call(this));
    this.curr_thread.$meta_stack = new CallStack([args]);
    debug("### finished runtime state initialization ###");
  }

  public dump_state(snapshot?, suffix?): void {
    var fs, _ref5;

    if (snapshot == null) {
      snapshot = this.meta_stack().snap();
    }
    suffix = suffix != null ? "-" + suffix : '';
    fs = (_ref5 = typeof node !== "undefined" && node !== null ? node.fs : void 0) != null ? _ref5 : require('fs');
    fs.writeFileSync("./core-" + (thread_name(this, this.curr_thread)) + suffix + ".json", JSON.stringify(snapshot.serialize()), 'utf8', true);
  }

  public choose_next_thread(blacklist: java_object.JavaThreadObject[], cb: (jto: java_object.JavaThreadObject)=>void): void {
    var b, bl, current_time, key, t, wakeup_time, _i, _j, _len, _len1, _ref5, _ref6, _ref7,
      _this = this;

    if (blacklist == null) {
      blacklist = [];
      _ref5 = this.waiting_threads;
      for (key in _ref5) {
        bl = _ref5[key];
        for (_i = 0, _len = bl.length; _i < _len; _i++) {
          b = bl[_i];
          blacklist.push(b);
        }
      }
    }
    wakeup_time = (_ref6 = this.curr_thread.wakeup_time) != null ? _ref6 : Infinity;
    current_time = (new Date).getTime();
    _ref7 = this.thread_pool;
    for (_j = 0, _len1 = _ref7.length; _j < _len1; _j++) {
      t = _ref7[_j];
      if (!(t !== this.curr_thread && t.$isAlive)) {
        continue;
      }
      if (this.parked(t)) {
        if (t.$park_timeout > current_time) {
          continue;
        }
        this.unpark(t);
      }
      if (blacklist.indexOf(t) >= 0) {
        continue;
      }
      if (t.wakeup_time > current_time) {
        if (t.wakeup_time < wakeup_time) {
          wakeup_time = t.wakeup_time;
        }
        continue;
      }
      debug("TE(choose_next_thread): choosing thread " + (thread_name(this, t)));
      return cb(t);
    }
    if ((Infinity > wakeup_time && wakeup_time > current_time)) {
      debug("TE(choose_next_thread): waiting until " + wakeup_time + " and trying again");
      setTimeout((function () {
        _this.choose_next_thread(null, cb);
      }), wakeup_time - current_time);
    } else {
      debug("TE(choose_next_thread): no thread found, sticking with curr_thread");
      cb(this.curr_thread);
    }
  }

  public wait(monitor: java_object.JavaObject, yieldee?: java_object.JavaThreadObject): void {
    var _this = this;

    debug("TE(wait): waiting " + (thread_name(this, this.curr_thread)) + " on lock " + monitor.ref);
    if (this.waiting_threads[monitor] != null) {
      this.waiting_threads[monitor].push(this.curr_thread);
    } else {
      this.waiting_threads[monitor] = [this.curr_thread];
    }
    if (yieldee != null) {
      return this.yield(yieldee);
    }
    this.choose_next_thread(this.waiting_threads[monitor], (function (nt) {
      _this.yield(nt);
    }));
  }

  public yield(yieldee: java_object.JavaThreadObject): void {
    var new_thread_sf, old_thread_sf,
      _this = this;

    debug("TE(yield): yielding " + (thread_name(this, this.curr_thread)) + " to " + (thread_name(this, yieldee)));
    old_thread_sf = this.curr_frame();
    this.curr_thread = yieldee;
    new_thread_sf = this.curr_frame();
    new_thread_sf.runner = function () {
      return _this.meta_stack().pop();
    };
    old_thread_sf.runner = function () {
      return _this.meta_stack().pop();
    };
  }

  public park(thread: java_object.JavaThreadObject, timeout: number): void {
    var _this = this;

    thread.$park_count++;
    thread.$park_timeout = timeout;
    debug("TE(park): parking " + (thread_name(this, thread)) + " (count: " + thread.$park_count + ", timeout: " + thread.$park_timeout + ")");
    if (this.parked(thread)) {
      this.choose_next_thread(null, (function (nt) {
        _this.yield(nt);
      }));
    }
  }

  public unpark(thread: java_object.JavaThreadObject): void {
    debug("TE(unpark): unparking " + (thread_name(this, thread)));
    thread.$park_count--;
    thread.$park_timeout = Infinity;
    if (!this.parked(thread)) {
      return this.yield(thread);
    }
  }

  public parked(thread: java_object.JavaThreadObject): bool {
    return thread.$park_count > 0;
  }

  public curr_frame(): StackFrame {
    return this.meta_stack().curr_frame();
  }

  public cl(idx: number): any {
    return this.curr_frame().locals[idx];
  }

  public put_cl(idx: number, val: any): void {
    this.curr_frame().locals[idx] = val;
  }

  public put_cl2(idx: number, val: any): void {
    this.put_cl(idx, val);
    (typeof UNSAFE !== "undefined" && UNSAFE !== null) || this.put_cl(idx + 1, null);
  }

  public push(arg: any): number {
    return this.curr_frame().stack.push(arg);
  }

  public push2(arg1: any, arg2: any): number {
    return this.curr_frame().stack.push(arg1, arg2);
  }

  public push_array(args: any[]): void {
    var cs;

    cs = this.curr_frame().stack;
    Array.prototype.push.apply(cs, args);
  }

  public pop(): any {
    return this.curr_frame().stack.pop();
  }

  public pop2(): any {
    this.pop();
    return this.pop();
  }

  public peek(depth?: number): any {
    var s;

    if (depth == null) {
      depth = 0;
    }
    s = this.curr_frame().stack;
    return s[s.length - 1 - depth];
  }

  public curr_pc(): number {
    return this.curr_frame().pc;
  }

  public goto_pc(pc: number): number {
    return this.curr_frame().pc = pc;
  }

  public inc_pc(n: number): number {
    return this.curr_frame().pc += n;
  }

  public check_null<T>(obj: T): T {
    if (obj == null) {
      this.java_throw(this.get_bs_class('Ljava/lang/NullPointerException;'), '');
    }
    return obj;
  }

  public heap_newarray(type: string, len: number): java_object.JavaArray {
    var _ref5;

    if (len < 0) {
      this.java_throw(this.get_bs_class('Ljava/lang/NegativeArraySizeException;'), "Tried to init [" + type + " array with length " + len);
    }
    if (type === 'J') {
      return new JavaArray(this, this.get_bs_class('[J'), util.arrayset<gLong>(len, gLong.ZERO));
    } else if ((_ref5 = type[0]) === 'L' || _ref5 === '[') {
      return new JavaArray(this, this.get_class("[" + type), util.arrayset<any>(len, null));
    } else {
      return new JavaArray(this, this.get_class("[" + type), util.arrayset<number>(len, 0));
    }
  }

  public init_string(str: string, intern?: bool): java_object.JavaObject {
    var carr, jvm_str, s;

    if (intern == null) {
      intern = false;
    }
    if (intern && ((s = this.string_pool.get(str)) != null)) {
      return s;
    }
    carr = this.init_carr(str);
    jvm_str = new JavaObject(this, this.get_bs_class('Ljava/lang/String;'), {
      'Ljava/lang/String;value': carr,
      'Ljava/lang/String;count': str.length
    });
    if (intern) {
      this.string_pool.set(str, jvm_str);
    }
    return jvm_str;
  }

  public init_carr(str: string): java_object.JavaArray {
    var carr, i, _i, _ref5;

    carr = new Array(str.length);
    for (i = _i = 0, _ref5 = str.length; _i < _ref5; i = _i += 1) {
      carr[i] = str.charCodeAt(i);
    }
    return new JavaArray(this, this.get_bs_class('[C'), carr);
  }

  public block_addr(l_address: gLong): number {
    var addr, block_addr, _i, _len, _ref5;

    var address = l_address.toNumber();
    if (typeof DataView !== "undefined" && DataView !== null) {
      block_addr = this.mem_start_addrs[0];
      _ref5 = this.mem_start_addrs.slice(1);
      for (_i = 0, _len = _ref5.length; _i < _len; _i++) {
        addr = _ref5[_i];
        if (address < addr) {
          return block_addr;
        }
        block_addr = addr;
      }
    } else {
      if (this.mem_blocks[address] != null) {
        return address;
      }
    }
    return (typeof UNSAFE !== "undefined" && UNSAFE !== null) || (function () {
      throw new Error("Invalid memory access at " + address);
    })();
  }

  public handle_toplevel_exception(e: any, no_threads: bool, done_cb: (bool)=>void): void {
    var _this = this;

    this.unusual_termination = true;
    if (e.toplevel_catch_handler != null) {
      this.run_until_finished((function () {
        e.toplevel_catch_handler(_this);
      }), no_threads, done_cb);
    } else {
      error("\nInternal JVM Error:", e);
      if ((e != null ? e.stack : void 0) != null) {
        error(e.stack);
      }
      done_cb(false);
    }
  }

  public async_op(cb: (resume_cb: (arg1?:any, arg2?:any, isBytecode?:bool, advancePc?:bool)=>void, except_cb: (e_fcn: ()=>void, discardStackFrame?:bool)=>void)=>void): void {
    throw new YieldIOException(cb);
  }

  public run_until_finished(setup_fn: ()=>void, no_threads: bool, done_cb: (bool)=>void): void {
    var _this = this;

    setImmediate((function () {
      var duration, e, failure_fn, frames_to_pop, m_count, ms_per_m, sf, stack: CallStack, start_time, success_fn;

      _this.stashed_done_cb = done_cb;
      try {
        setup_fn();
        start_time = (new Date()).getTime();
        m_count = _this.max_m_count;
        sf = _this.curr_frame();
        while ((sf.runner != null) && m_count > 0) {
          sf.runner();
          m_count--;
          sf = _this.curr_frame();
        }
        if ((sf.runner != null) && m_count === 0) {
          duration = (new Date()).getTime() - start_time;
          if (duration > 2000 || duration < 1000) {
            ms_per_m = duration / _this.max_m_count;
            _this.max_m_count = (1000 / ms_per_m) | 0;
          }
          return _this.run_until_finished((function () { }), no_threads, done_cb);
        }
        if (no_threads || _this.thread_pool.length <= 1) {
          return done_cb(true);
        }
        debug("TE(toplevel): finished thread " + (thread_name(_this, _this.curr_thread)));
        _this.curr_thread.$isAlive = false;
        _this.thread_pool.splice(_this.thread_pool.indexOf(_this.curr_thread), 1);
        return _this.choose_next_thread(null, function (next_thread) {
          _this.curr_thread = next_thread;
          return _this.run_until_finished((function () { }), no_threads, done_cb);
        });
      } catch (_error) {
        e = _error;
        if (e === ReturnException) {
          _this.run_until_finished((function () { }), no_threads, done_cb);
        } else if (e instanceof YieldIOException) {
          success_fn = function (ret1, ret2, bytecode, advance_pc) {
            if (advance_pc == null) {
              advance_pc = true;
            }
            if (bytecode) {
              _this.meta_stack().push(StackFrame.native_frame("async_op"));
            }
            _this.curr_frame().runner = function () {
              _this.meta_stack().pop();
              if (bytecode && advance_pc) {
                _this.curr_frame().pc += 1 + _this.curr_frame().method.code.opcodes[_this.curr_frame().pc].byte_count;
              }
              if (ret1 !== void 0) {
                if (typeof ret1 === 'boolean') {
                  ret1 += 0;
                }
                _this.push(ret1);
              }
              if (ret2 !== void 0) {
                return _this.push(ret2);
              }
            };
            return _this.run_until_finished((function () { }), no_threads, done_cb);
          };
          failure_fn = function (e_cb) {
            _this.meta_stack().push(StackFrame.native_frame("async_op"));
            _this.curr_frame().runner = function () {
              _this.meta_stack().pop();
              return e_cb();
            };
            return _this.run_until_finished((function () { }), no_threads, done_cb);
          };
          e.condition(success_fn, failure_fn);
        } else {
          stack = _this.meta_stack();
          if ((e.method_catch_handler != null) && stack.length() > 1) {
            frames_to_pop = 0;
            while (!e.method_catch_handler(_this, stack.get_caller(frames_to_pop), frames_to_pop === 0)) {
              if (stack.length() === ++frames_to_pop) {
                if (JVM.dump_state) {
                  _this.dump_state();
                }
                stack.pop_n(stack.length() - 1);
                _this.handle_toplevel_exception(e, no_threads, done_cb);
                return;
              }
            }
            stack.pop_n(frames_to_pop);
            _this.run_until_finished((function () { }), no_threads, done_cb);
          } else {
            if (JVM.dump_state) {
              _this.dump_state();
            }
            stack.pop_n(Math.max(stack.length() - 1, 0));
            _this.handle_toplevel_exception(e, no_threads, done_cb);
          }
        }
      }
    }));
  }

  public async_input(n_bytes: number, resume: (string)=>void): void {
    var data,
      _this = this;

    if (this.input_buffer.length > 0) {
      data = this.input_buffer.slice(0, n_bytes);
      this.input_buffer = this.input_buffer.slice(n_bytes);
      resume(data);
      return;
    }
    this._async_input(function (data) {
      if (data.length > n_bytes) {
        _this.input_buffer = data.slice(n_bytes);
      }
      resume(data.slice(0, n_bytes));
    });
  }
}