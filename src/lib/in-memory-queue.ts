import { EventEmitter } from "node:events";
import pLimit from "p-limit";

export interface PackageJobData {
  packageName: string;
}

class InMemoryQueue extends EventEmitter {
  private queue: PackageJobData[] = [];
  private limit: pLimit.Limit;

  constructor(concurrency: number = 5) {
    super();
    this.limit = pLimit(concurrency);
  }

  add(job: PackageJobData) {
    this.queue.push(job);
    this.emit("new-job");
  }

  async process(worker: (job: PackageJobData) => Promise<void>) {
    this.on("new-job", () => {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (job) {
          this.limit(() => worker(job)).catch(e => {
            console.error("In-memory queue worker error:", e);
          });
        }
      }
    });
  }
}

export const packageQueue = new InMemoryQueue();
