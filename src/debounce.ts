export const DEFAULT_DEBOUNCE_MS = 600;
const MAX_DEBOUNCE_MS = 5_000;
const MAX_BATCH_AGE_MS = 5_000;
const MAX_BATCH_CHARS = 16_000;

interface PendingBatch<T, C> {
  parts: string[];
  waiters: Array<(result: T) => void>;
  startedAt: number;
  context: C;
  timer?: ReturnType<typeof setTimeout>;
  flushing?: Promise<T>;
}

export function debounceDelayFromEnv(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return DEFAULT_DEBOUNCE_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_DEBOUNCE_MS;
  return Math.min(parsed, MAX_DEBOUNCE_MS);
}

export class TimeGapDebouncer<T, C> {
  private current?: PendingBatch<T, C>;
  private processQueue = Promise.resolve();

  constructor(
    private readonly delayMs: number,
    private readonly process: (text: string, context: C) => Promise<T>,
  ) {}

  add(text: string, context: C): Promise<T> {
    if (text.length > MAX_BATCH_CHARS) {
      if (this.current) void this.flushBatch(this.current);
      return this.enqueue(text, context);
    }

    if (this.current && this.current.parts.join("\n\n").length + text.length + 2 > MAX_BATCH_CHARS) {
      void this.flushBatch(this.current);
    }

    const batch = this.current ?? {
      parts: [],
      waiters: [],
      startedAt: Date.now(),
      context,
    };
    this.current = batch;
    batch.parts.push(text);

    const result = new Promise<T>((resolve) => batch.waiters.push(resolve));
    if (batch.timer) clearTimeout(batch.timer);
    const remainingMaxAge = Math.max(0, MAX_BATCH_AGE_MS - (Date.now() - batch.startedAt));
    batch.timer = setTimeout(() => void this.flushBatch(batch), Math.min(this.delayMs, remainingMaxAge));
    return result;
  }

  flush(): Promise<void> {
    if (this.current) void this.flushBatch(this.current);
    return this.processQueue;
  }

  private enqueue(text: string, context: C): Promise<T> {
    const result = this.processQueue.then(() => this.process(text, context));
    this.processQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private flushBatch(batch: PendingBatch<T, C>): Promise<T> {
    if (batch.flushing) return batch.flushing;
    if (batch.timer) clearTimeout(batch.timer);
    if (this.current === batch) this.current = undefined;

    batch.flushing = this.enqueue(batch.parts.join("\n\n"), batch.context);
    batch.flushing.then(
      (result) => batch.waiters.forEach((resolve) => resolve(result)),
      () => batch.waiters.forEach((resolve) => resolve(undefined as T)),
    );
    return batch.flushing;
  }
}
