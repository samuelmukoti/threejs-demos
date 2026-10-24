import {
  ACESFilmicToneMapping,
  HalfFloatType,
  PCFSoftShadowMap,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { settings } from '../settings.js';

const MSAA_SAMPLES = 4;
const BLOOM_THRESHOLD = 0.9;

// Radial + mild directional blur toward screen centre; strength 0 is a pass-through.
const MotionBlurShader = {
  name: 'MotionBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec2 dir = (vUv - vec2(0.5)) * strength * 0.06;
      vec4 sum = vec4(0.0);
      for (int i = 0; i < 6; i++) {
        sum += texture2D(tDiffuse, vUv - dir * float(i));
      }
      gl_FragColor = sum / 6.0;
    }
  `,
};

export function configureRenderer(renderer) {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = settings.lighting.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.info.autoReset = false;
  return renderer;
}

export function resetInfo(renderer) {
  renderer.info.reset();
}

function resolveQuality(quality) {
  if (typeof quality === 'string') {
    const preset = settings.qualityPresets[quality];
    if (!preset) throw new Error(`Unknown quality preset: ${quality}`);
    return { ...preset };
  }
  return { ...(quality || {}) };
}

export function createComposer(renderer, scene, camera, initialSettings = settings.quality) {
  const size = renderer.getSize(new Vector2());
  let width = Math.max(1, size.x);
  let height = Math.max(1, size.y);
  let pixelRatio = renderer.getPixelRatio();

  const useMsaa = renderer.capabilities.maxSamples > 0;
  const target = new WebGLRenderTarget(width * pixelRatio, height * pixelRatio, {
    type: HalfFloatType,
    format: RGBAFormat,
    samples: useMsaa ? MSAA_SAMPLES : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);

  const state = { ssao: 'off', ssaoScale: 1, dof: false, bloom: true, motionBlur: false };
  let currentCamera = camera;

  const renderPass = new RenderPass(scene, camera);
  const ssaoPass = new SSAOPass(scene, camera, width, height);
  ssaoPass.kernelRadius = 0.6;
  ssaoPass.minDistance = 0.002;
  ssaoPass.maxDistance = 0.08;
  const baseSsaoSetSize = ssaoPass.setSize.bind(ssaoPass);
  ssaoPass.setSize = (w, h) => baseSsaoSetSize(
    Math.max(1, Math.floor(w * state.ssaoScale)),
    Math.max(1, Math.floor(h * state.ssaoScale)),
  );
  const bokehPass = new BokehPass(scene, camera, { focus: 20, aperture: 0.0004, maxblur: 0.006 });
  const bloomPass = new UnrealBloomPass(new Vector2(width, height), 0.55, 0.6, BLOOM_THRESHOLD);
  const motionPass = new ShaderPass(new ShaderMaterial({
    name: MotionBlurShader.name,
    uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
    vertexShader: MotionBlurShader.vertexShader,
    fragmentShader: MotionBlurShader.fragmentShader,
  }));
  const smaaPass = useMsaa ? null : new SMAAPass();
  const outputPass = new OutputPass();

  const passes = [renderPass, ssaoPass, bokehPass, bloomPass, motionPass, smaaPass, outputPass];
  for (const pass of passes) if (pass) composer.addPass(pass);

  ssaoPass.enabled = false;
  bokehPass.enabled = false;
  motionPass.enabled = false;

  function applySize() {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
  }

  function setQuality(quality) {
    const q = resolveQuality(quality);
    if ('ssao' in q) {
      const v = q.ssao;
      state.ssao = v === 'half' ? 'half' : v ? 'on' : 'off';
      const scale = state.ssao === 'half' ? 0.5 : 1;
      const changed = scale !== state.ssaoScale;
      state.ssaoScale = scale;
      ssaoPass.enabled = state.ssao !== 'off';
      if (changed) applySize();
    }
    if ('dof' in q) {
      state.dof = !!q.dof;
      bokehPass.enabled = state.dof;
    }
    if ('bloom' in q) {
      state.bloom = !!q.bloom;
      bloomPass.enabled = state.bloom;
    }
    if ('motionBlur' in q) {
      state.motionBlur = !!q.motionBlur;
      motionPass.enabled = state.motionBlur && motionPass.uniforms.strength.value > 0;
    }
    return { ...state };
  }

  function setDofFocus(distance) {
    if (Number.isFinite(distance) && distance > 0) bokehPass.uniforms.focus.value = distance;
  }

  function setMotionBlur(intensity) {
    const v = Number.isFinite(intensity) ? Math.max(0, intensity) : 0;
    motionPass.uniforms.strength.value = v;
    motionPass.enabled = state.motionBlur && v > 0;
  }

  function setCamera(cam) {
    currentCamera = cam;
    renderPass.camera = cam;
    ssaoPass.camera = cam;
    bokehPass.camera = cam;
  }

  function resize(w, h, ratio = pixelRatio) {
    width = Math.max(1, w);
    height = Math.max(1, h);
    pixelRatio = ratio;
    applySize();
  }

  function render() {
    composer.render();
  }

  function dispose() {
    for (const pass of passes) if (pass && pass.dispose) pass.dispose();
    composer.dispose();
    target.dispose();
  }

  setQuality(initialSettings);
  setCamera(currentCamera);

  return {
    composer,
    passes: { renderPass, ssaoPass, bokehPass, bloomPass, motionPass, smaaPass, outputPass },
    setQuality,
    setDofFocus,
    setMotionBlur,
    setCamera,
    resize,
    render,
    dispose,
  };
}
