/**
 * Utilitaires de conversion audio pour Twilio Media Streams.
 * µ-law 8 kHz ↔ PCM 24 kHz / 16 kHz / 32 kHz
 * Ne pas modifier : utilisé par server-core.js pour le pipeline Twilio.
 */

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const uval = (~i) & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  MULAW_DECODE_TABLE[i] = (uval & 0x80) ? (0x84 - t) : (t - 0x84);
}
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_SEG_END = [0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF, 0x3FFF, 0x7FFF];

function clamp16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x;
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
  sample = sample + MULAW_BIAS;
  let seg = 0;
  while (seg < 8 && sample > MULAW_SEG_END[seg]) seg++;
  if (seg > 7) seg = 7;
  const mantissa = (sample >> (seg + 3)) & 0x0f;
  const uval = sign | (seg << 4) | mantissa;
  return (~uval) & 0xff;
}

function resample8kTo24k(pcm8k) {
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i];
    const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
    pcm24k[i * 3] = s0;
    pcm24k[i * 3 + 1] = (2 * s0 + s1) / 3;
    pcm24k[i * 3 + 2] = (s0 + 2 * s1) / 3;
  }
  return pcm24k;
}

function convertMulawToPcm24k(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulawBuffer[i] & 0xFF];
  }
  return resample8kTo24k(pcm8k);
}

function convertPcm24kToMulaw(pcm24k) {
  const outLen = Math.floor(pcm24k.length / 3);
  const mulaw = new Uint8Array(outLen);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < outLen; i++) {
    const a = pcm24k[i * 3];
    const b = pcm24k[i * 3 + 1];
    const c = pcm24k[i * 3 + 2];
    const avg = (a + b + c) / 3;
    const gained = clamp16((avg * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return mulaw;
}

function convertPcm32kToMulaw(pcm32k) {
  const outLen = Math.floor(pcm32k.length / 4);
  const mulaw = new Uint8Array(outLen);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < outLen; i++) {
    const a = pcm32k[i * 4];
    const b = pcm32k[i * 4 + 1];
    const c = pcm32k[i * 4 + 2];
    const d = pcm32k[i * 4 + 3];
    const avg = (a + b + c + d) / 4;
    const gained = clamp16((avg * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return mulaw;
}

function convertPcm8kToMulaw(pcm8k) {
  const mulaw = new Uint8Array(pcm8k.length);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < pcm8k.length; i++) {
    const gained = clamp16((pcm8k[i] * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return mulaw;
}

function convertPcm16kBlockToMulaw(pcm16kBlockBuf) {
  const sampleCount = Math.floor(pcm16kBlockBuf.length / 2);
  const pcm16k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm16k[i] = pcm16kBlockBuf.readInt16LE(i * 2);
  }
  const outLen = Math.floor(pcm16k.length / 2);
  const mulaw = new Uint8Array(outLen);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < outLen; i++) {
    const a = pcm16k[i * 2];
    const b = pcm16k[i * 2 + 1];
    const avg = (a + b) / 2;
    const gained = clamp16((avg * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return Buffer.from(mulaw);
}

function avgAbsMulaw(mulawBuf) {
  if (!mulawBuf || mulawBuf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = MULAW_DECODE_TABLE[mulawBuf[i] & 0xff];
    sum += Math.abs(s);
  }
  return sum / mulawBuf.length;
}

export {
  clamp16,
  mulawEncodeSample,
  resample8kTo24k,
  convertMulawToPcm24k,
  convertPcm24kToMulaw,
  convertPcm32kToMulaw,
  convertPcm8kToMulaw,
  convertPcm16kBlockToMulaw,
  avgAbsMulaw,
  MULAW_DECODE_TABLE,
};
