import {
  collectVisibleGCodeBackgroundTaskControlItems,
  getGCodeBackgroundTaskControlItemElapsedMs,
  isActiveGCodeBackgroundTaskControlItem,
  parseGCodeBackgroundTaskControlItems,
  type GCodeBackgroundTaskControlItem,
  type GCodeBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type GCodeBackgroundBashJobStatus = GCodeBackgroundTaskControlStatus;
export type GCodeBackgroundBashJob = GCodeBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseGCodeBackgroundBashJobs(value: unknown): GCodeBackgroundBashJob[] {
  return parseGCodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveGCodeBackgroundBashJob(job: GCodeBackgroundBashJob): boolean {
  return isActiveGCodeBackgroundTaskControlItem(job);
}

export function getGCodeBackgroundBashJobElapsedMs(
  job: GCodeBackgroundBashJob,
  now = Date.now(),
): number {
  return getGCodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleGCodeBackgroundBashJobs(
  jobs: readonly GCodeBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<GCodeBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleGCodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    GCodeBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: GCodeBackgroundTaskControlItem): job is GCodeBackgroundBashJob {
  return job.taskKind === "bash";
}
