import { Queue } from "bullmq";

export interface PackageJobData {
  packageName: string;
  version?: string;
  previousVersion?: string | null;
}

const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,
};

export const packageQueue = new Queue<PackageJobData>("package-scan", {
  connection,
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
    },
    removeOnFail: {
      age: 3600, // Keep failed jobs for 1 hour
    },
  },
});
