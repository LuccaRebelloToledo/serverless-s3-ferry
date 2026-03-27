import { type Plugin, PROGRESS_STEP } from '@shared';

interface CreateProgressTrackerOptions {
  progressEntry: Plugin.Progress;
  buildMessage: (percent: number) => string;
}

export function createProgressTracker(options: CreateProgressTrackerOptions): {
  update(amount: number, total: number): void;
  remove(): void;
} {
  const { progressEntry, buildMessage } = options;
  let percent = 0;

  return {
    update(amount: number, total: number) {
      if (total === 0) return;
      const current =
        Math.round((amount / total) * PROGRESS_STEP) * PROGRESS_STEP;
      if (current > percent) {
        percent = current;
        progressEntry.update(buildMessage(percent));
      }
    },
    remove() {
      progressEntry.remove();
    },
  };
}
