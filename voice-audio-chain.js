/**
 * Chaîne audio sortante (téléphonie 8 kHz) : DC block, accent présence, compresseur doux, normalisation RMS lente.
 * État par appel (une instance par WebSocket Twilio).
 */

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let uval = (~i) & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  MULAW_DECODE_TABLE[i] = uval & 0x80 ? 0x84 - t : t - 0x84;
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function clamp16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

function mulawEncodeSample(pcm16) {
  let sample = pcm16;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
    if (sample < 0) sample = 32767;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let seg = 0;
  while (seg < 8 && sample > MULAW_SEG_END[seg]) seg++;
  if (seg > 7) seg = 7;
  const mantissa = (sample >> (seg + 3)) & 0x0f;
  const uval = sign | (seg << 4) | mantissa;
  return (~uval) & 0xff;
}

export function createVoiceChainState() {
  return {
    dcXm1: 0,
    dcYm1: 0,
    presXm1: 0,
    compEnv: 0,
    normSmooth: 1,
  };
}

export function resetVoiceChainState(s) {
  if (!s) return;
  s.dcXm1 = 0;
  s.dcYm1 = 0;
  s.presXm1 = 0;
  s.compEnv = 0;
  s.normSmooth = 1;
}

/**
 * @param {Int16Array} samples — PCM mono 8 kHz, modifié en place
 * @param {object} state — createVoiceChainState()
 * @param {object} [opts]
 */
export function processVoiceChainPcm8k(samples, state, opts = {}) {
  if (!samples || samples.length === 0 || !state) return;

  const fs = 8000;
  const dcCoef = opts.dcCoef ?? 0.995;
  const presence = opts.presence ?? 0.1;
  const targetRms = opts.targetRms ?? 0.07;
  const normAlpha = opts.normAlpha ?? 0.07;
  const compThresh = opts.compThreshold ?? 0.2;
  const compRatio = opts.compRatio ?? 2.2;
  const compMix = opts.compMix ?? 0.45;
  const attack = Math.exp(-1 / Math.max(1, 0.004 * fs));
  const release = Math.exp(-1 / Math.max(1, 0.1 * fs));

  const tmp = new Float32Array(samples.length);
  let sumSq = 0;

  for (let i = 0; i < samples.length; i++) {
    const xRaw = samples[i];
    const yDc = xRaw - state.dcXm1 + dcCoef * state.dcYm1;
    state.dcXm1 = xRaw;
    state.dcYm1 = yDc;

    let f = yDc / 32768;
    const presIn = f;
    f = presIn + presence * (presIn - state.presXm1);
    state.presXm1 = presIn;

    tmp[i] = f;
    sumSq += f * f;
  }

  const rms = Math.sqrt(sumSq / samples.length);
  let g = 1;
  if (rms > 1e-8) g = Math.min(2.4, targetRms / rms);
  state.normSmooth = state.normSmooth * (1 - normAlpha) + g * normAlpha;
  const ng = state.normSmooth;

  for (let i = 0; i < samples.length; i++) {
    let x = tmp[i] * ng;
    const ax = Math.abs(x);
    if (ax > state.compEnv) state.compEnv = ax + (1 - attack) * (state.compEnv - ax);
    else state.compEnv = ax + (1 - release) * (state.compEnv - ax);

    let gain = 1;
    if (state.compEnv > compThresh) {
      const over = state.compEnv / compThresh;
      gain = Math.pow(over, ((1 / compRatio - 1) * compMix));
    }
    x *= gain;
    samples[i] = clamp16(Math.round(x * 32768));
  }
}

/** μ-law 8 kHz → Int16Array mono */
export function mulawToPcm8kInt16(mulawBuf) {
  const n = mulawBuf.length;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = MULAW_DECODE_TABLE[mulawBuf[i] & 0xff];
  return out;
}

/** Int16Array 8 kHz → Buffer μ-law (160 bytes typ.) */
export function pcm8kInt16ToMulawBuffer(pcm8k, outputGain = 1) {
  const mulaw = new Uint8Array(pcm8k.length);
  const g = Number.isFinite(outputGain) ? outputGain : 1;
  for (let i = 0; i < pcm8k.length; i++) {
    mulaw[i] = mulawEncodeSample(clamp16((pcm8k[i] * g) | 0));
  }
  return Buffer.from(mulaw);
}
