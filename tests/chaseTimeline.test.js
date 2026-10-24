import { describe, it, expect } from 'vitest';
import { createChaseTimeline, buildDefaultTimeline } from '../src/animation/chaseTimeline.js';

describe('chaseTimeline', () => {
  it('addShot is chainable', () => {
    const tl = createChaseTimeline();
    expect(tl.addShot('a', 0, 1)).toBe(tl);
    expect(tl.addShot('b', 1, 2).shots).toHaveLength(2);
  });

  it('rejects non-contiguous or empty shots', () => {
    const tl = createChaseTimeline().addShot('a', 0, 1);
    expect(() => tl.addShot('b', 2, 3)).toThrow();
    expect(() => tl.addShot('c', 1, 1)).toThrow();
  });

  it('default timeline has 10 contiguous ordered shots totalling 35-45 s', () => {
    const tl = buildDefaultTimeline();
    expect(tl.shots).toHaveLength(10);
    expect(tl.shots[0].start).toBe(0);
    for (let i = 1; i < tl.shots.length; i++) {
      expect(tl.shots[i].start).toBe(tl.shots[i - 1].end);
    }
    expect(tl.duration).toBeGreaterThanOrEqual(35);
    expect(tl.duration).toBeLessThanOrEqual(45);
  });

  it('picks the active shot at boundaries', () => {
    const tl = buildDefaultTimeline();
    expect(tl.evaluate(0).shot.name).toBe('establishing');
    expect(tl.evaluate(4.999).shot.name).toBe('establishing');
    expect(tl.evaluate(5).shot.name).toBe('leadReveal');
    expect(tl.evaluate(tl.duration).shot.name).toBe('endFrame');
    expect(tl.evaluate(tl.duration + 10).shot.name).toBe('endFrame');
  });

  it('keeps localProgress within 0..1', () => {
    const tl = buildDefaultTimeline();
    for (let x = -1; x <= tl.duration + 1; x += 0.37) {
      const { localProgress } = tl.evaluate(x);
      expect(localProgress).toBeGreaterThanOrEqual(0);
      expect(localProgress).toBeLessThanOrEqual(1);
    }
    expect(tl.evaluate(7.5).localProgress).toBeCloseTo(0.5);
  });

  it('seek(0) then update(1/60) gives t = 1/60', () => {
    const tl = buildDefaultTimeline();
    tl.seek(0);
    expect(tl.update(1 / 60).t).toBeCloseTo(1 / 60, 10);
  });

  it('honours pause and playbackSpeed, and clamps to duration', () => {
    const tl = buildDefaultTimeline();
    tl.pause();
    expect(tl.update(1).t).toBe(0);
    tl.resume();
    tl.playbackSpeed = 2;
    expect(tl.update(1).t).toBe(2);
    tl.update(1000);
    expect(tl.t).toBe(tl.duration);
    tl.reset();
    expect(tl.t).toBe(0);
  });

  it('evaluate does not mutate state', () => {
    const tl = buildDefaultTimeline();
    tl.seek(3);
    tl.evaluate(20);
    expect(tl.t).toBe(3);
  });
});
