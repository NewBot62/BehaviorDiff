#!/usr/bin/env python3
"""BehaviorDiff Python runner. Same JSON-lines protocol as the Node runner.

  runner.py list   <file>                          -> {"exports": [...], "sigs": {...}, "sources": {...}, "numbers": [...], "strings": [...]}
  runner.py consts <file>                          -> {"numbers": [...], "strings": [...]}   (literals only; nothing is imported)
  runner.py run    <file> <target> <inputs.json> <start> <timeout_ms>

Targets: `f` (function), `C` (construct, result = instance state), `C#m` (inputs are [ctor_args, method_args]), `C.m` (static/class method).
Sandbox: an audit hook blocks file writes, deleting/renaming files, subprocesses and network. Time, random and uuid are fixed.
"""
import ast, sys, os, json, math, importlib, importlib.util, inspect, signal, dataclasses, typing, enum, decimal, datetime as _dt, io, traceback

_out_fd = os.dup(1)


def emit(o):
    data = (json.dumps(o, ensure_ascii=False) + "\n").encode("utf-8")
    while data:
        n = os.write(_out_fd, data)
        data = data[n:]


# ---------------------------------------------------------------- static analysis (ast)

def ann_to_shape(a):
    """Annotation AST -> BehaviorDiff Shape."""
    U = {"k": "unknown"}
    if a is None:
        return U
    if isinstance(a, ast.Constant):
        if a.value is None:
            return {"k": "null"}
        if isinstance(a.value, str):  # forward reference like "int"
            try:
                return ann_to_shape(ast.parse(a.value, mode="eval").body)
            except Exception:
                return U
    if isinstance(a, ast.Name):
        n = a.id
        if n in ("int", "float", "complex"):
            return {"k": "number"}
        if n in ("str", "bytes"):
            return {"k": "string"}
        if n == "bool":
            return {"k": "boolean"}
        if n in ("list", "List", "Sequence", "Iterable", "set", "Set", "frozenset", "FrozenSet", "MutableSequence", "Collection"):
            return {"k": "array", "of": U}
        if n in ("dict", "Dict", "Mapping", "MutableMapping"):
            return {"k": "record", "of": U}
        if n in ("tuple", "Tuple"):
            return {"k": "array", "of": U}
        if n in ("datetime", "date"):
            return {"k": "date"}
        return U
    if isinstance(a, ast.Attribute):
        return ann_to_shape(ast.Name(id=a.attr))
    if isinstance(a, ast.BinOp) and isinstance(a.op, ast.BitOr):
        return {"k": "union", "of": [ann_to_shape(a.left), ann_to_shape(a.right)]}
    if isinstance(a, ast.Subscript):
        base = a.value.id if isinstance(a.value, ast.Name) else (a.value.attr if isinstance(a.value, ast.Attribute) else "")
        sl = a.slice
        elts = sl.elts if isinstance(sl, ast.Tuple) else [sl]
        if base in ("Optional",):
            return {"k": "union", "of": [ann_to_shape(elts[0]), {"k": "null"}]}
        if base == "Union":
            return {"k": "union", "of": [ann_to_shape(e) for e in elts]}
        if base in ("list", "List", "Sequence", "Iterable", "set", "Set", "frozenset", "FrozenSet", "MutableSequence", "Collection"):
            return {"k": "array", "of": ann_to_shape(elts[0])}
        if base in ("dict", "Dict", "Mapping", "MutableMapping"):
            return {"k": "record", "of": ann_to_shape(elts[1]) if len(elts) > 1 else U}
        if base in ("tuple", "Tuple"):
            if len(elts) == 2 and isinstance(elts[1], ast.Constant) and elts[1].value is Ellipsis:
                return {"k": "array", "of": ann_to_shape(elts[0])}
            return {"k": "tuple", "of": [ann_to_shape(e) for e in elts]}
        if base == "Literal":
            vals = [e.value for e in elts if isinstance(e, ast.Constant)]
            return {"k": "literal", "values": vals} if vals else U
        if base in ("Annotated", "Final", "ClassVar"):
            return ann_to_shape(elts[0])
    return U


def default_shape(d):
    if isinstance(d, ast.Constant):
        v = d.value
        if isinstance(v, bool):
            return {"k": "boolean"}
        if isinstance(v, (int, float)):
            return {"k": "number"}
        if isinstance(v, str):
            return {"k": "string"}
    if isinstance(d, (ast.List, ast.Tuple, ast.Set)):
        return {"k": "array", "of": {"k": "unknown"}}
    if isinstance(d, ast.Dict):
        return {"k": "record", "of": {"k": "unknown"}}
    return {"k": "unknown"}


class Info:
    def __init__(self, tree, src):
        self.tree, self.src = tree, src
        self.dataclasses = {}
        for n in tree.body:
            if isinstance(n, ast.ClassDef) and self._is_dc(n):
                self.dataclasses[n.name] = n

    @staticmethod
    def _is_dc(n):
        for d in n.decorator_list:
            t = d.func if isinstance(d, ast.Call) else d
            name = t.id if isinstance(t, ast.Name) else (t.attr if isinstance(t, ast.Attribute) else "")
            if name == "dataclass":
                return True
        return any((isinstance(b, ast.Name) and b.id in ("TypedDict", "NamedTuple", "BaseModel")) for b in n.bases)

    def shape(self, a, depth=0):
        if isinstance(a, ast.Name) and a.id in self.dataclasses and depth < 3:
            props = []
            for st in self.dataclasses[a.id].body:
                if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                    props.append({"name": st.target.id, "optional": st.value is not None, "shape": self.shape(st.annotation, depth + 1)})
            return {"k": "object", "props": props}
        s = ann_to_shape(a)
        return s

    def params(self, fn, skip_self):
        a = fn.args
        out = []
        pos = list(a.posonlyargs) + list(a.args)
        defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
        for i, (p, d) in enumerate(zip(pos, defaults)):
            if i == 0 and skip_self and p.arg in ("self", "cls"):
                continue
            shp = self.shape(p.annotation) if p.annotation is not None else (default_shape(d) if d is not None else {"k": "unknown"})
            out.append({"name": p.arg, "optional": d is not None, "rest": False, "shape": shp})
        if a.vararg:
            out.append({"name": a.vararg.arg, "optional": True, "rest": True, "shape": self.shape(a.vararg.annotation) if a.vararg.annotation else {"k": "unknown"}})
        return out


def consts(tree):
    nums, strs = [], []
    seen_n, seen_s = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant):
            v = n.value
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)) and math.isfinite(v) and v not in seen_n:
                seen_n.add(v)
                nums.append(v)
            elif isinstance(v, str) and 0 < len(v) <= 60 and v not in seen_s and "\n" not in v:
                seen_s.add(v)
                strs.append(v)
    return nums[:120], strs[:200]


def public(name):
    return not name.startswith("_")


def analyze_file(path):
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    info = Info(tree, src)
    sigs, sources, exports = {}, {}, []
    explicit = None
    for n in tree.body:  # __all__ = [...]
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in n.targets) and isinstance(n.value, (ast.List, ast.Tuple)):
            explicit = {e.value for e in n.value.elts if isinstance(e, ast.Constant)}

    def seg(n):
        t = ast.get_source_segment(src, n) or ""
        return t if len(t) < 3000 else t[:3000] + "\n# ...truncated"

    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(n.name) and (explicit is None or n.name in explicit):
            sigs[n.name] = {"name": n.name, "params": info.params(n, False)}
            sources[n.name] = seg(n)
        elif isinstance(n, ast.ClassDef) and public(n.name) and (explicit is None or n.name in explicit):
            init = next((m for m in n.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name == "__init__"), None)
            if init is not None:
                sigs[n.name] = {"name": n.name, "params": info.params(init, True)}
            elif n.name in info.dataclasses:
                props = [{"name": st.target.id, "optional": st.value is not None, "rest": False, "shape": info.shape(st.annotation)} for st in n.body if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name)]
                sigs[n.name] = {"name": n.name, "params": props}
            else:
                sigs[n.name] = {"name": n.name, "params": []}
            sources[n.name] = seg(n) if len(seg(n)) < 800 else (ast.get_source_segment(src, init) if init else "")
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(m.name):
                    decos = {d.id if isinstance(d, ast.Name) else getattr(d, "attr", "") for d in m.decorator_list}
                    if "property" in decos or m.name.startswith("__"):
                        continue
                    static = "staticmethod" in decos or "classmethod" in decos
                    key = f"{n.name}.{m.name}" if static else f"{n.name}#{m.name}"
                    sigs[key] = {"name": key, "params": info.params(m, not ("staticmethod" in decos))}
                    sources[key] = seg(m)
    nums, strs = consts(tree)
    return sigs, sources, nums, strs


# ---------------------------------------------------------------- runtime

def load_module(path):
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    # a file inside a package (has __init__.py siblings) is imported as part of it, so relative imports work
    parts = [os.path.splitext(os.path.basename(path))[0]]
    root = d
    while os.path.exists(os.path.join(root, "__init__.py")) and os.path.dirname(root) != root:
        parts.insert(0, os.path.basename(root))
        root = os.path.dirname(root)
    sys.path.insert(0, root)
    if len(parts) > 1:
        # the package copy under test must win over any installed copy of the same name
        for k in [k for k in sys.modules if k == parts[0] or k.startswith(parts[0] + ".")]:
            del sys.modules[k]
        return importlib.import_module(".".join(parts))
    sys.path.insert(1, d)
    name = "bd_target_" + parts[0].replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def install_determinism():
    import random, time, uuid
    FIXED = 1718452800.0  # 2024-06-15T12:00:00Z
    time.time = lambda: FIXED
    time.time_ns = lambda: int(FIXED * 1e9)
    time.monotonic = lambda: 1000.0
    time.perf_counter = lambda: 1000.0
    real_dt, real_date = _dt.datetime, _dt.date

    class FixedDT(real_dt):
        @classmethod
        def now(cls, tz=None):
            base = real_dt.fromtimestamp(FIXED, _dt.timezone.utc)
            return base.astimezone(tz) if tz else base.replace(tzinfo=None)

        @classmethod
        def utcnow(cls):
            return real_dt.fromtimestamp(FIXED, _dt.timezone.utc).replace(tzinfo=None)

        @classmethod
        def today(cls):
            return cls.now()

    class FixedDate(real_date):
        @classmethod
        def today(cls):
            return real_date(2024, 6, 15)

    _dt.datetime = FixedDT
    _dt.date = FixedDate
    rnd = random.Random(42)
    uuid.uuid4 = lambda: uuid.UUID(int=rnd.getrandbits(128), version=4)
    os.urandom = lambda n: bytes(rnd.getrandbits(8) for _ in range(n))


def reset_random():
    import random
    random.seed(42)


BLOCKED_PREFIXES = ("subprocess.", "socket.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.remove", "os.rename", "os.replace", "os.rmdir", "os.mkdir", "os.truncate", "os.symlink", "os.link", "os.chmod", "os.chown", "os.kill", "shutil.rmtree", "shutil.move", "shutil.copy", "ctypes.dlopen", "urllib.Request", "http.client.connect")


def install_sandbox():
    def hook(event, args):
        if event == "open":
            mode = args[1] if len(args) > 1 and isinstance(args[1], str) else "r"
            flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
            if any(c in mode for c in "wax+") or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                path = str(args[0])
                if path not in ("/dev/null",):
                    raise PermissionError(f"behaviordiff sandbox: writing files is blocked ({path})")
        elif event.startswith(BLOCKED_PREFIXES) or event in ("os.system", "pty.spawn"):
            raise PermissionError(f"behaviordiff sandbox: {event} is blocked")
    sys.addaudithook(hook)


MAXD = 10


def enc(v, depth=0, seen=None):
    if seen is None:
        seen = set()
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if abs(v) < 2 ** 53 else {"$b": str(v)}
    if isinstance(v, float):
        if math.isnan(v):
            return {"$n": "NaN"}
        if math.isinf(v):
            return {"$n": "Infinity" if v > 0 else "-Infinity"}
        if v == 0 and math.copysign(1, v) < 0:
            return {"$n": "-0"}
        return v if v != int(v) or abs(v) >= 2 ** 53 else (int(v) if False else v)
    if isinstance(v, str):
        return v
    if isinstance(v, (bytes, bytearray)):
        return {"$by": bytes(v).hex()[:200]}
    if id(v) in seen:
        return {"$cycle": 1}
    if depth > MAXD:
        return {"$deep": 1}
    seen = seen | {id(v)}
    r = lambda x: enc(x, depth + 1, seen)
    if isinstance(v, _dt.datetime):
        return {"$d": v.isoformat()}
    if isinstance(v, _dt.date):
        return {"$d": v.isoformat()}
    if isinstance(v, decimal.Decimal):
        return {"$c": "Decimal", "v": {"value": str(v)}}
    if isinstance(v, enum.Enum):
        return {"$c": type(v).__name__, "v": {"name": v.name, "value": r(v.value)}}
    if isinstance(v, BaseException):
        return {"$e": {"name": type(v).__name__, "message": str(v)}}
    if isinstance(v, tuple):
        return {"$t": [r(x) for x in v]}
    if isinstance(v, list):
        return [r(x) for x in v]
    if isinstance(v, (set, frozenset)):
        items = [r(x) for x in v]
        items.sort(key=lambda x: json.dumps(x, sort_keys=True, default=str))
        return {"$set": items}
    if isinstance(v, dict):
        out = {}
        for k in sorted(v.keys(), key=lambda k: str(k)):
            ks = k if isinstance(k, str) else str(k)
            ks = "$" + ks if ks.startswith("$") else ks
            out[ks] = r(v[k])
        return out
    if callable(v) and not hasattr(v, "__dict__"):
        return {"$f": getattr(v, "__name__", "anonymous")}
    if inspect.isgenerator(v):
        return {"$c": "generator", "v": {"items": [r(x) for x in list(__import__("itertools").islice(v, 50))]}}
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return {"$c": type(v).__name__, "v": {f.name: r(getattr(v, f.name, None)) for f in sorted(dataclasses.fields(v), key=lambda f: f.name)}}
    try:
        d = {k: x for k, x in vars(v).items() if not callable(x)}
        return {"$c": type(v).__name__, "v": {("$" + k if k.startswith("$") else k): r(d[k]) for k in sorted(d)}}
    except TypeError:
        return {"$c": type(v).__name__, "v": {"repr": repr(v)[:200]}}


def dec(e):
    if e is None or isinstance(e, (bool, int, float, str)):
        return e
    if isinstance(e, list):
        return [dec(x) for x in e]
    if "$u" in e:
        return None
    if "$n" in e:
        return {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf"), "-0": -0.0}[e["$n"]]
    if "$b" in e:
        return int(e["$b"])
    if "$d" in e:
        s = e["$d"]
        try:
            return _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if "$set" in e:
        try:
            return set(dec(x) for x in e["$set"])
        except TypeError:
            return [dec(x) for x in e["$set"]]
    if "$r" in e or "$f" in e or "$p" in e or "$cycle" in e or "$deep" in e or "$e" in e or "$s" in e:
        return None
    if "$m" in e:
        return {str(dec(k)): dec(v) for k, v in e["$m"]}
    if "$ta" in e:
        return [dec(x) for x in e["v"]]
    if "$c" in e:
        return dec(e["v"])
    return {(k[1:] if k.startswith("$$") else k): dec(v) for k, v in e.items()}


def coerce(value, hint, depth=0):
    """Make generic JSON-like inputs fit the declared Python type where we can."""
    if depth > 4:
        return value
    origin = typing.get_origin(hint)
    args = typing.get_args(hint)
    try:
        if hint is int:
            if isinstance(value, float) and math.isfinite(value):
                return int(value)
            return value
        if hint is float:
            return float(value) if isinstance(value, int) and not isinstance(value, bool) else value
        if hint is _dt.date and isinstance(value, _dt.datetime):
            return value.date()
        if hint in (set, frozenset) and isinstance(value, list):
            return hint(value)
        if hint is tuple and isinstance(value, list):
            return tuple(value)
        if hint is bytes and isinstance(value, str):
            return value.encode()
        if hint is decimal.Decimal and isinstance(value, (int, float, str)):
            return decimal.Decimal(str(value))
        if isinstance(hint, type) and issubclass(hint, enum.Enum):
            if isinstance(value, str) and value in hint.__members__:
                return hint[value]
            try:
                return hint(value)
            except Exception:
                return value
        if dataclasses.is_dataclass(hint) and isinstance(value, dict):
            hints = typing.get_type_hints(hint)
            kw = {k: coerce(v, hints.get(k), depth + 1) for k, v in value.items() if k in hints}
            return hint(**kw)
        if origin in (list, set, frozenset, typing.Sequence) and args and isinstance(value, list):
            items = [coerce(x, args[0], depth + 1) for x in value]
            return items if origin in (list, typing.Sequence) else origin(items)
        if origin is tuple and isinstance(value, list):
            if len(args) == 2 and args[1] is Ellipsis:
                return tuple(coerce(x, args[0], depth + 1) for x in value)
            return tuple(coerce(x, a, depth + 1) for x, a in zip(value, args)) if len(args) == len(value) else tuple(value)
        if origin is dict and isinstance(value, dict) and len(args) == 2:
            return {k: coerce(v, args[1], depth + 1) for k, v in value.items()}
        if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
            for a in args:
                if a is type(None):
                    if value is None:
                        return None
                    continue
                c = coerce(value, a, depth + 1)
                if c is not value:
                    return c
            return value
    except Exception:
        return value
    return value


def coerce_args(fn, args):
    try:
        hints = typing.get_type_hints(fn)
        params = [p for p in inspect.signature(fn).parameters.values()]
    except Exception:
        return args
    out = list(args)
    names = [p.name for p in params if p.name not in ("self", "cls")]
    for i, a in enumerate(out):
        if i < len(names) and names[i] in hints:
            out[i] = coerce(a, hints[names[i]])
    return out


def _snap(args):
    try:
        return json.dumps(enc(args), sort_keys=True, default=str)
    except Exception:
        return repr(args)


class Timeout(BaseException):
    pass


def _alarm(sig, frm):
    raise Timeout()


class Capture(io.TextIOBase):
    def __init__(self, kind, logs):
        self.kind, self.logs = kind, logs

    def write(self, s):
        if s and len(self.logs) < 20:
            self.logs.append(f"{self.kind}: {s}"[:300])
        return len(s)

    def flush(self):
        pass


def snapshot(inst):
    try:
        if dataclasses.is_dataclass(inst):
            return {f.name: getattr(inst, f.name, None) for f in dataclasses.fields(inst)}
        return {k: v for k, v in vars(inst).items() if not callable(v) and not k.startswith("__")}
    except Exception:
        return "<unreadable state>"


def main():
    mode = sys.argv[1]
    path = sys.argv[2]
    if mode == "consts":
        nums, strs = consts(ast.parse(open(path, encoding="utf-8").read()))
        emit({"numbers": nums, "strings": strs})
        return
    try:
        sigs, sources, nums, strs = analyze_file(path)
    except SyntaxError as e:
        emit({"fatal": f"syntax error: {e}"})
        return
    install_determinism()
    install_sandbox()
    real_out, real_err = sys.stdout, sys.stderr
    logs = []
    sys.stdout, sys.stderr = Capture("stdout", logs), Capture("stderr", logs)
    try:
        mod = load_module(path)
    except BaseException as e:  # noqa
        sys.stdout, sys.stderr = real_out, real_err
        emit({"fatal": f"cannot import {os.path.basename(path)}: {type(e).__name__}: {str(e)[:300]}"})
        return
    if mode == "list":
        exports = []
        for k in sigs:
            ptr = k
            cls_name = k.split("#")[0].split(".")[0]
            obj = getattr(mod, cls_name, None)
            if obj is None:
                continue
            is_cls = inspect.isclass(obj) and k == cls_name
            try:
                arity = len(sigs[k]["params"])
            except Exception:
                arity = 0
            exports.append({"name": k, "arity": arity, "isClass": is_cls})
        sys.stdout, sys.stderr = real_out, real_err
        emit({"exports": exports, "sigs": sigs, "sources": sources, "numbers": nums, "strings": strs})
        return

    target, inputs_file, start, timeout_ms = sys.argv[3], sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
    inputs = json.load(open(inputs_file))
    hash_ = target.find("#")
    dot = target.find(".")
    cls_name = target[:hash_] if hash_ > 0 else (target[:dot] if dot > 0 else None)
    member = target[hash_ + 1:] if hash_ > 0 else (target[dot + 1:] if dot > 0 else None)
    cls = getattr(mod, cls_name) if cls_name else None
    fn = getattr(mod, target, None) if not cls_name else None
    is_ctor = fn is not None and inspect.isclass(fn)
    signal.signal(signal.SIGALRM, _alarm)
    emit({"ready": 1})
    for i in range(start, len(inputs)):
        decoded = [dec(x) for x in inputs[i]]
        logs.clear()
        reset_random()
        res = None
        inst = None
        second = None
        try:
            signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000.0)
            if hash_ > 0:
                ctor_args = decoded[0]
                margs = decoded[1]
                inst = cls(*coerce_args(cls.__init__ if hasattr(cls, "__init__") else cls, ctor_args))
                m = getattr(inst, member)
                args = coerce_args(m, margs)
                pre = _snap(args)
                r = m(*args)
                if inspect.isawaitable(r):
                    import asyncio
                    r = asyncio.run(r)
                nxt = [dec(x) for x in inputs[(i + 1) % len(inputs)]][1]
                m2 = getattr(inst, member)
                s2 = m2(*coerce_args(m2, nxt))
                if inspect.isawaitable(s2):
                    import asyncio
                    s2 = asyncio.run(s2)
                second = enc(s2)
                after_args = margs
            elif dot > 0:
                m = getattr(cls, member)
                args = coerce_args(m, decoded)
                pre = _snap(args)
                r = m(*args)
                if inspect.isawaitable(r):
                    import asyncio
                    r = asyncio.run(r)
                after_args = decoded
            elif is_ctor:
                args = coerce_args(fn.__init__ if hasattr(fn, "__init__") else fn, decoded)
                pre = _snap(args)
                inst = fn(*args)
                r = snapshot(inst)
                after_args = decoded
            else:
                args = coerce_args(fn, decoded)
                pre = _snap(args)
                r = fn(*args)
                if inspect.isawaitable(r):
                    import asyncio
                    r = asyncio.run(r)
                after_args = decoded
            signal.setitimer(signal.ITIMER_REAL, 0)
            res = {"ok": True, "value": enc(r), "after": (enc(decoded) if hash_ <= 0 and _snap(args) == pre else enc(args)) if hash_ <= 0 else enc(margs if _snap(args) == pre else args), "logs": list(logs)}
            if hash_ > 0:
                res["state"] = enc(snapshot(inst))
                res["second"] = second
        except Timeout:
            emit({"i": i, "r": {"timeout": True}})
            continue
        except BaseException as e:  # noqa
            signal.setitimer(signal.ITIMER_REAL, 0)
            if isinstance(e, (KeyboardInterrupt,)):
                raise
            res = {"ok": False, "err": {"name": type(e).__name__, "message": str(e)[:300]}, "after": enc(decoded), "logs": list(logs)}
            if hash_ > 0 and inst is not None:
                res["state"] = enc(snapshot(inst))
        emit({"i": i, "r": res})
    emit({"done": 1})


if __name__ == "__main__":
    try:
        main()
    except BaseException as e:  # noqa
        emit({"fatal": f"{type(e).__name__}: {str(e)[:400]}"})
    sys.stdout = sys.__stdout__
    os._exit(0)
