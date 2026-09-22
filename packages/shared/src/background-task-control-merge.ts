import type { GCodeBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeGCodeBackgroundTaskControlItems(
  current: readonly GCodeBackgroundTaskControlItem[],
  updates: readonly GCodeBackgroundTaskControlItem[],
): GCodeBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
