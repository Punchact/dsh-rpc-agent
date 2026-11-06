/**
 * In-flight request registry for the MCP stdio server.
 *
 * JSON-RPC ids are only unique among *outstanding* requests — a client may reuse
 * one afterwards. A bare `Map<String(id), AbortController>` cannot express that:
 * the older request completing would delete the newer request's controller, and a
 * cancel for that id would then silently do nothing (the call would keep running
 * until it finished on its own).
 *
 * Every entry therefore remembers which controller it registered, and removal is
 * guarded by identity, so a late completion can never evict a live controller.
 */

export function createInflight() {
  const controllers = new Map();

  return {
    /**
     * Register a controller for `id`. Returns the controller and whatever it
     * replaced, so a caller can tell an overlap from a fresh request.
     */
    begin(id, controller = new AbortController()) {
      const key = String(id);
      const previous = controllers.get(key);
      controllers.set(key, controller);
      return { controller, previous };
    },

    /** Abort the controller currently registered for `id`; false when absent. */
    cancel(id) {
      const controller = controllers.get(String(id));
      if (!controller) return false;
      controller.abort();
      return true;
    },

    /**
     * Remove `controller` only when it is still the registered one for `id`.
     * Returns false when a newer request took the id over — nothing is removed.
     */
    settle(id, controller) {
      const key = String(id);
      if (controllers.get(key) !== controller) return false;
      controllers.delete(key);
      return true;
    },

    get size() {
      return controllers.size;
    },
  };
}
