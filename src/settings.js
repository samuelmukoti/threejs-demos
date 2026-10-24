// Central configuration. Pure module: no three or DOM imports.

const vehicleDefaults = {
  mass: 1450,
  maxSpeed: 62,
  acceleration: 18,
  brakingForce: 30,
  steeringResponse: 2.8,
  grip: 1.15,
  driftFactor: 0.72,
  suspensionStiffness: 0.8,
  dimensions: { length: 4.5, width: 1.85, height: 1.35 },
};

const qualityPresets = {
  low: {
    shadows: false, bloom: false, ssao: false, rainParticles: 3000,
    reflectionQuality: 0.25, motionBlur: false, dof: false,
    distantTraffic: 4, pixelRatioMax: 1,
  },
  medium: {
    shadows: true, bloom: true, ssao: false, rainParticles: 8000,
    reflectionQuality: 0.5, motionBlur: false, dof: false,
    distantTraffic: 10, pixelRatioMax: 1.5,
  },
  high: {
    shadows: true, bloom: true, ssao: true, rainParticles: 18000,
    reflectionQuality: 1, motionBlur: true, dof: true,
    distantTraffic: 20, pixelRatioMax: 2,
  },
};

export const settings = {
  lighting: {
    exposure: 1.1,
    moon: { color: 0x6f8fd8, intensity: 0.6 },
    streetlight: { color: 0xffc27a, intensity: 40, distance: 22, spacing: 18 },
    neon: { colors: [0xff2a9d, 0x20e3ff, 0x9d4dff], intensity: 12 },
    headlight: { color: 0xfff1d6, intensity: 60, distance: 45, angle: 0.5 },
    brake: { color: 0xff1a1a, intensity: 4 },
    tunnel: { color: 0xffa63d, intensity: 18, spacing: 8 },
    fog: { color: 0x0a0f1c, density: 0.018 },
  },
  rain: { intensity: 1, speed: 28, streakLength: 0.9, wind: 2.5, wetness: 0.85 },
  vehicles: {
    lead: { ...vehicleDefaults, dimensions: { ...vehicleDefaults.dimensions }, bodyColor: 0x111218 },
    pursuer: {
      ...vehicleDefaults,
      suspensionStiffness: 0.55,
      dimensions: { length: 4.9, width: 2.0, height: 1.45 },
      bodyColor: 0x6a0f14,
    },
  },
  timeline: {
    fixedStep: 1 / 120,
    fadeStart: 42.5,
    duration: 44,
    shots: [
      { name: 'establishing', start: 0, end: 5 },
      { name: 'leadReveal', start: 5, end: 10 },
      { name: 'pursuit', start: 10, end: 14 },
      { name: 'sideBySide', start: 14, end: 18 },
      { name: 'intersection', start: 18, end: 23 },
      { name: 'tunnel', start: 23, end: 29 },
      { name: 'drift', start: 29, end: 33 },
      { name: 'nearMiss', start: 33, end: 36 },
      { name: 'escape', start: 36, end: 42 },
      { name: 'endFrame', start: 42, end: 44 },
    ],
  },
  route: {
    // [x, z] waypoints; vehicles travel toward -z.
    boulevard: [[0, 60], [0, 20], [0, -20], [0, -60], [0, -100]],
    intersection: [[0, -100], [0, -120], [0, -140]],
    tunnel: [[0, -140], [0, -180], [0, -240], [0, -300]],
    sideStreet: [[0, -300], [0, -320], [-8, -334], [-24, -342], [-44, -344]],
  },
  lod: { near: 25, mid: 70, far: 160 },
  quality: { ...qualityPresets.high },
  reducedQuality: false,
  qualityPresets,
};

export function applyQualityPreset(name) {
  const preset = qualityPresets[name];
  if (!preset) throw new Error(`Unknown quality preset: ${name}`);
  Object.assign(settings.quality, preset);
  settings.reducedQuality = name === 'low';
  return settings.quality;
}
