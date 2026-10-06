/** Poll only after the preceding read settles; slow RPCs must still be allowed to finish.
 * Callers own error state and identity guards. Cleanup prevents future polls.
 */
export function pollAfterCompletion(read: () => Promise<unknown>, delay: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await read(); } catch { /* The caller reports its read failure. */ }
    finally { if (!stopped) timer = setTimeout(() => void tick(), delay); }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
