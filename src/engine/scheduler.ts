import pLimit from "p-limit";

export interface WorkItem {
  id: string;
  kind: string;
  run: () => Promise<void>;
}

export class Scheduler {
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly inFlight = new Set<string>();

  constructor(concurrency = 2) {
    this.limit = pLimit(concurrency);
  }

  enqueue(item: WorkItem): Promise<void> | undefined {
    if (this.inFlight.has(item.id)) {
      return undefined;
    }
    this.inFlight.add(item.id);
    return this.limit(async () => {
      try {
        await item.run();
      } finally {
        this.inFlight.delete(item.id);
      }
    });
  }

  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }
}
