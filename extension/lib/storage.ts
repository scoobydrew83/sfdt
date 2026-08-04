// Every chrome.storage read/write outside the service worker goes through here.
//
// Why this exists: a content script whose extension has been reloaded or updated
// is "orphaned" — the page keeps running the old script, but its chrome.* handles
// are dead, and the first call throws `Extension context invalidated`. Chrome
// updates extensions underneath open tabs, so this is a routine end-user event,
// not just a dev-loop artifact: every Salesforce tab open at update time starts
// throwing from whatever touches storage next.
//
// There is no recovering an orphaned script — the tab has to reload — so the
// contract here is only "fail quietly and truthfully":
//   - reads resolve `undefined`, which every caller already handles as "no value
//     stored yet" and turns into its own default;
//   - writes resolve `false` instead of throwing, so a caller that cares can tell
//     a dead context from a successful save;
//   - listener registration hands back a no-op unsubscribe.
//
// Two details that are easy to get wrong:
//   1. The throw is SYNCHRONOUS, on the call itself. Wrapping the promise body
//      is not enough on its own — `new Promise(cb)` would convert it into a
//      rejection, which surfaces as "Uncaught (in promise)" instead. `try` has
//      to sit around the chrome.* call, inside the executor, and resolve the
//      fallback.
//   2. Each callback reads `chrome.runtime.lastError`. That is what suppresses
//      Chrome's "Unchecked runtime.lastError" console warning on the ASYNC
//      failures (quota exceeded, and so on) — a different failure mode from the
//      invalidated context, and one the try/catch never sees.

/** Swallow the async error Chrome parks on `lastError` for the current callback. */
function drainLastError(): void {
  void chrome.runtime?.lastError;
}

/** Reads one key. Resolves `undefined` when unset OR when the context is dead. */
export async function storageGet<T = unknown>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (result) => {
        drainLastError();
        resolve(result?.[key] as T | undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Writes one key. Resolves `false` when the write could not be made. */
export async function storageSet(key: string, value: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => {
        // A quota/serialisation failure lands on lastError with the callback
        // still firing, so read it before deciding the write succeeded.
        const failed = !!chrome.runtime?.lastError;
        resolve(!failed);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Deletes one key. Resolves `false` when the removal could not be made. */
export async function storageRemove(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(key, () => {
        const failed = !!chrome.runtime?.lastError;
        resolve(!failed);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Subscribes to changes of a single key in `local`. The callback receives the
 * new raw value (`undefined` when the key was removed); validation stays with
 * the caller, which owns the schema.
 *
 * Returns an unsubscribe that is safe to call after the context has died —
 * teardown paths run during exactly the window where that happens.
 */
export function onStorageChange(
  key: string,
  callback: (newValue: unknown) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    namespace: string,
  ): void => {
    if (namespace !== 'local') return;
    if (!changes[key]) return;
    callback(changes[key].newValue);
  };

  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // Already gone with the context.
    }
  };
}
