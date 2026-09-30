export function cancellationError() {
  const error = new Error("运行已取消");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw cancellationError();
}

export function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function delayWithAbort(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

