export type InitialOutcome<T> =
  | { state: "confirmed"; value: T }
  | { state: "pending" };

/**
 * Waits only for the initial UI outcome. The supplied completion promise is
 * never cancelled or replaced, so callers can reconcile its eventual result.
 */
export async function waitForInitialOutcome<T>(
  completion: PromiseLike<T>,
  timeoutMs: number,
): Promise<InitialOutcome<T>> {
  const pending = Symbol("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve(completion),
      new Promise<typeof pending>((resolve) => {
        timer = setTimeout(() => resolve(pending), timeoutMs);
      }),
    ]);
    return outcome === pending
      ? { state: "pending" }
      : { state: "confirmed", value: outcome as T };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tracks process-local mutation ownership and aggregate activity. */
export class OperationCoordinator {
  private count = 0;
  private readonly mutationVersions = new Map<number, number>();
  private readonly onActivityChange: (count: number) => void;

  constructor(onActivityChange: (count: number) => void = () => undefined) {
    this.onActivityChange = onActivityChange;
  }

  get activeCount(): number {
    return this.count;
  }

  beginOperation(): () => void {
    let finished = false;
    this.count += 1;
    this.onActivityChange(this.count);
    return () => {
      if (finished) return;
      finished = true;
      this.count = Math.max(0, this.count - 1);
      this.onActivityChange(this.count);
    };
  }

  nextMutationVersion(cardId: number): number {
    const version = (this.mutationVersions.get(cardId) ?? 0) + 1;
    this.mutationVersions.set(cardId, version);
    return version;
  }

  isCurrentMutation(cardId: number, version: number): boolean {
    return this.mutationVersions.get(cardId) === version;
  }
}
