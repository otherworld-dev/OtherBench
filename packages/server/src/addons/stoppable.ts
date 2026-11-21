/**
 * A host an add-on can be cut off from (docs/features/addons.md): once `stop` is called, reading anything from it, or
 * calling anything got from it earlier (`host.jobs.createChat`, `host.secrets.get`, `host.git.publish`…), throws.
 * Used for an add-on that failed to start, whose code may still be running. Methods are called on the real object,
 * so classes with private fields (JobGit) work as before.
 */
export function stoppable<T extends object>(target: T, id: string): { host: T; stop: () => void } {
  let stopped = false;
  const refuse = (): never => {
    throw new Error(`Add-on ${id} was stopped, so it can no longer use OtherBench.`);
  };
  const proxies = new WeakMap<object, object>();
  const real = new WeakMap<object, object>();

  const wrap = <V>(value: V): V => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
    const obj = value as object;
    const known = proxies.get(obj);
    if (known) return known as V;
    const proxy = new Proxy(obj, {
      get(t, key) {
        if (stopped) refuse();
        const v: unknown = Reflect.get(t, key, t);
        // A fixed property must read back as itself (a proxy rule), so it is handed out as it is.
        const d = Reflect.getOwnPropertyDescriptor(t, key);
        if (d && !d.configurable && d.writable === false) return v;
        return wrap(v);
      },
      set(t, key, v) {
        if (stopped) refuse();
        return Reflect.set(t, key, v, t);
      },
      apply(t, thisArg, args) {
        if (stopped) refuse();
        const self = (typeof thisArg === 'object' || typeof thisArg === 'function') && thisArg !== null ? (real.get(thisArg as object) ?? thisArg) : thisArg;
        return Reflect.apply(t as (...a: unknown[]) => unknown, self, args);
      },
    });
    proxies.set(obj, proxy);
    real.set(proxy, obj);
    return proxy as V;
  };

  return {
    host: wrap(target),
    stop: () => {
      stopped = true;
    },
  };
}
