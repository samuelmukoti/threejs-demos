import { describe, it, expect } from 'vitest';
import { settings, applyQualityPreset } from '../src/settings.js';

describe('settings', () => {
  it('has required vehicle values', () => {
    for (const v of Object.values(settings.vehicles)) {
      expect(v.mass).toBe(1450);
      expect(v.maxSpeed).toBe(62);
      expect(v.acceleration).toBe(18);
      expect(v.brakingForce).toBe(30);
      expect(v.steeringResponse).toBe(2.8);
      expect(v.grip).toBe(1.15);
      expect(v.driftFactor).toBe(0.72);
    }
    expect(settings.vehicles.lead.suspensionStiffness).toBe(0.8);
    expect(settings.vehicles.pursuer.suspensionStiffness).toBeLessThan(0.8);
    expect(settings.lighting.exposure).toBe(1.1);
  });
  it('has contiguous shots totalling 35-45 s', () => {
    const { shots } = settings.timeline;
    expect(shots[0].start).toBe(0);
    for (let i = 1; i < shots.length; i++) expect(shots[i].start).toBe(shots[i - 1].end);
    const total = shots[shots.length - 1].end;
    expect(total).toBeGreaterThanOrEqual(35);
    expect(total).toBeLessThanOrEqual(45);
  });
  it('applies quality presets', () => {
    const keys = Object.keys(settings.qualityPresets.high).sort();
    for (const n of ['low', 'medium', 'high']) {
      expect(Object.keys(settings.qualityPresets[n]).sort()).toEqual(keys);
    }
    expect(settings.quality.rainParticles).toBe(18000);
    applyQualityPreset('low');
    expect(settings.quality.rainParticles).toBe(3000);
    expect(settings.reducedQuality).toBe(true);
    applyQualityPreset('medium');
    expect(settings.quality.rainParticles).toBe(8000);
    applyQualityPreset('high');
    expect(settings.reducedQuality).toBe(false);
    expect(() => applyQualityPreset('x')).toThrow();
  });
});
