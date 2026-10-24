import { describe, it, expect, vi } from 'vitest';
import { createAudioBus, AUDIO_EVENTS } from '../src/audio/audioBus.js';

function setup(options = {}) {
  let now = 0;
  const logger = vi.fn();
  const bus = createAudioBus({ clock: () => now, logger, ...options });
  return { bus, logger, advance: (ms) => { now += ms; } };
}

describe('audioBus', () => {
  it('logs to the console fallback when no backend exists', () => {
    const { bus, logger } = setup();
    bus.emit('impact', { vehicleId: 'lead', strength: 1 });
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][0]).toContain('impact');
  });

  it('does not log when a backend is present', () => {
    const { bus, logger } = setup({ hasBackend: true });
    bus.emit('impact', {});
    expect(logger).not.toHaveBeenCalled();
  });

  it('delivers payloads to named and wildcard subscribers', () => {
    const { bus } = setup();
    const named = vi.fn(), all = vi.fn();
    bus.subscribe('gearChange', named);
    bus.subscribe('*', all);
    bus.emit('gearChange', { vehicleId: 'lead', gear: 3 });
    bus.emit('beat', { index: 1, t: 0.5 });
    expect(named).toHaveBeenCalledTimes(1);
    expect(named).toHaveBeenCalledWith({ vehicleId: 'lead', gear: 3 }, 'gearChange');
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('throttles continuous events in the log but not for subscribers', () => {
    const { bus, logger, advance } = setup();
    const cb = vi.fn();
    bus.subscribe('engine', cb);
    for (let i = 0; i < 10; i++) {
      bus.emit('engine', { rpm: 3000 + i });
      advance(10);
    }
    expect(logger).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(10);
    advance(1000);
    bus.emit('engine', { rpm: 5000 });
    expect(logger).toHaveBeenCalledTimes(2);
  });

  it('throttles per event name independently and never throttles one-shots', () => {
    const { bus, logger } = setup();
    bus.emit('engine', {});
    bus.emit('tireSqueal', {});
    bus.emit('beat', {});
    bus.emit('beat', {});
    expect(logger).toHaveBeenCalledTimes(4);
  });

  it('suppresses emission while seeking', () => {
    const { bus, logger } = setup();
    const cb = vi.fn();
    bus.subscribe('*', cb);
    bus.setSuppressed(true);
    expect(bus.emit('impact', {})).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
    bus.setSuppressed(false);
    expect(bus.emit('impact', {})).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', () => {
    const { bus } = setup();
    const cb = vi.fn();
    const off = bus.subscribe('rain', cb);
    off();
    bus.emit('rain', { intensity: 1 });
    expect(cb).not.toHaveBeenCalled();
    expect(bus.unsubscribe('rain', cb)).toBe(false);
  });

  it('isolates subscriber errors', () => {
    const { bus } = setup();
    const good = vi.fn();
    bus.subscribe('brake', () => { throw new Error('boom'); });
    bus.subscribe('brake', good);
    expect(() => bus.emit('brake', { intensity: 1 })).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('dispose removes listeners and ignores later emits', () => {
    const { bus, logger } = setup();
    const cb = vi.fn();
    bus.subscribe('*', cb);
    bus.dispose();
    expect(bus.emit('impact', {})).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
    expect(() => bus.subscribe('beat', cb)()).not.toThrow();
  });

  it('exposes the spec event names', () => {
    expect(AUDIO_EVENTS).toEqual([
      'engine', 'tireSqueal', 'gearChange', 'brake', 'rain', 'impact', 'tunnel', 'beat',
    ]);
  });
});
