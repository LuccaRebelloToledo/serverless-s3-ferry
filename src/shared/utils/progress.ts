import type { Plugin } from '@shared';

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
      const current = Math.round((amount / total) * 10) * 10;
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
