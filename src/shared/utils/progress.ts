import type { Plugin } from '@shared';

export function createProgressTracker(
  progressEntry: Plugin.Progress,
  buildMessage: (percent: number) => string,
): { update(amount: number, total: number): void; remove(): void } {
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
