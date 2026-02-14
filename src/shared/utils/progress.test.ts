import { createProgressTracker } from '@shared';
import { mockProgress } from '@shared/testing';
import { describe, expect, it } from 'vitest';

describe('createProgressTracker', () => {
  it('updates in 10% increments', () => {
    const progress = mockProgress();
    const tracker = createProgressTracker(progress, (p) => `${p}%`);

    tracker.update(1, 10); // 10%
    tracker.update(2, 10); // 20%
    tracker.update(3, 10); // 30%

    expect(progress.update).toHaveBeenCalledTimes(3);
    expect(progress.update).toHaveBeenCalledWith('10%');
    expect(progress.update).toHaveBeenCalledWith('20%');
    expect(progress.update).toHaveBeenCalledWith('30%');
  });

  it('does not update for same percentage', () => {
    const progress = mockProgress();
    const tracker = createProgressTracker(progress, (p) => `${p}%`);

    tracker.update(1, 10); // 10%
    tracker.update(1, 10); // still 10%, no update

    expect(progress.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing when total is 0', () => {
    const progress = mockProgress();
    const tracker = createProgressTracker(progress, (p) => `${p}%`);

    tracker.update(5, 0);

    expect(progress.update).not.toHaveBeenCalled();
  });

  it('remove() calls progressEntry.remove()', () => {
    const progress = mockProgress();
    const tracker = createProgressTracker(progress, (p) => `${p}%`);

    tracker.remove();

    expect(progress.remove).toHaveBeenCalled();
  });
});
