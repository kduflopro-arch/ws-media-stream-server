// WebSocket server for Twilio Media Streams + OpenAI Realtime API
// Deploy on Render / Railway / Fly. Not for Vercel (no persistent WS).
// Ports: Render auto-assigns process.env.PORT; locally use 8080.

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Readable } from "stream";
 
 // Empêche les "bonjour" répétés en cas de reconnexion du stream Twilio pendant le même appel.
 // Map<callSid, expiresAtMs>
 const greetedCallSidCache = new Map();
 function hasGreetedRecently(callSid) {
   if (!callSid) return false;
   const now = Date.now();
   const exp = greetedCallSidCache.get(callSid);
   if (exp && exp > now) return true;
   if (exp && exp <= now) greetedCallSidCache.delete(callSid);
   return false;
 }
 function markGreeted(callSid, ttlMs = 10 * 60 * 1000) {
   if (!callSid) return;
   greetedCallSidCache.set(callSid, Date.now() + ttlMs);
   // Limiter la taille au cas où (simple LRU-ish)
   if (greetedCallSidCache.size > 500) {
     const firstKey = greetedCallSidCache.keys().next().value;
     if (firstKey) greetedCallSidCache.delete(firstKey);
   }
 }

// Table de décodage μ-law → PCM16 (8kHz)
// + encode μ-law standard G.711 (évite les artefacts/brouillage)
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  // standard μ-law decode
  let uval = (~i) & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  MULAW_DECODE_TABLE[i] = (uval & 0x80) ? (0x84 - t) : (t - 0x84);
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
// Bornes de segments G.711 μ-law (pour PCM16 après bias) :
// 0xFF .. 0x7FFF (sinon l'encode part en vrille et Twilio entend du "brouillage")
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

  // segment
  let seg = 0;
  while (seg < 8 && sample > MULAW_SEG_END[seg]) seg++;
  if (seg > 7) seg = 7;

  // mantissa
  const mantissa = (sample >> (seg + 3)) & 0x0f;
  const uval = sign | (seg << 4) | mantissa;
  return (~uval) & 0xff;
}

// Rééchantillonnage 8kHz → 24kHz (interpolation linéaire)
function resample8kTo24k(pcm8k) {
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i];
    const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
    pcm24k[i * 3] = s0;
    // fractions 1/3 et 2/3 vers l'échantillon suivant
    pcm24k[i * 3 + 1] = (2 * s0 + s1) / 3;
    pcm24k[i * 3 + 2] = (s0 + 2 * s1) / 3;
  }
  return pcm24k;
}

// Convertir μ-law (8kHz) → PCM16 (24kHz)
function convertMulawToPcm24k(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulawBuffer[i] & 0xFF];
  }
  return resample8kTo24k(pcm8k);
}

// Convertir PCM16 (24kHz) → μ-law (8kHz)
function convertPcm24kToMulaw(pcm24k) {
  // Downsample 24kHz -> 8kHz avec une moyenne sur 3 samples (anti-aliasing léger).
  // Prendre uniquement 1 sample sur 3 crée des artefacts (son "brouillé"/métallique).
  const outLen = Math.floor(pcm24k.length / 3);
  const mulaw = new Uint8Array(outLen);
  // Gain sortie (améliore l'intelligibilité en téléphonie). Ajustable par env.
  // IMPORTANT: 1.25 a tendance à clipper et fatigue l'oreille en téléphonie.
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

// Convertir PCM16 (32kHz) → μ-law (8kHz)
function convertPcm32kToMulaw(pcm32k) {
  // Downsample 32kHz -> 8kHz avec une moyenne sur 4 samples (anti-aliasing léger).
  // Prendre uniquement 1 sample sur 4 crée des artefacts (son "brouillé"/métallique).
  const outLen = Math.floor(pcm32k.length / 4);
  const mulaw = new Uint8Array(outLen);
  // Gain sortie (améliore l'intelligibilité en téléphonie). Ajustable par env.
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

// Convertir PCM16 (8kHz) → μ-law (8kHz) - pas de downsampling
function convertPcm8kToMulaw(pcm8k) {
  const mulaw = new Uint8Array(pcm8k.length);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < pcm8k.length; i++) {
    const gained = clamp16((pcm8k[i] * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return mulaw;
}

// Convertir PCM16 (16kHz) → μ-law (8kHz) par blocs 20ms:
// 20ms @16kHz = 320 samples = 640 bytes → downsample 2:1 → 160 samples → 160 bytes μ-law
function convertPcm16kBlockToMulaw(pcm16kBlockBuf) {
  // Attendu: 640 bytes (320 samples)
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

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Format audio Realtime côté OpenAI.
// IMPORTANT: en pratique, OpenAI Realtime renvoie très souvent du PCM16 même si on demande g711_ulaw,
// et envoyer du PCM16 à Twilio comme si c'était du μ-law produit un "brouillage" extrêmement fort.
// On sécurise donc par défaut en PCM16.
const OPENAI_AUDIO_FORMAT = (process.env.OPENAI_AUDIO_FORMAT || "pcm16").toLowerCase();

if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY non configuré !");

// Mode pipeline:
// - realtime (historique): Twilio ↔ OpenAI Realtime (audio) (+ éventuellement ElevenLabs voix)
// - stt_llm_tts (Option B): VAD local → STT (Whisper) → LLM (texte) → TTS (ElevenLabs)
const PIPELINE_MODE_RAW = String(process.env.PIPELINE_MODE ?? "realtime").toLowerCase().trim();
// Tolérance: certains envs peuvent contenir "gpt-realtime", "openai-realtime", etc.
const PIPELINE_MODE =
  PIPELINE_MODE_RAW === "stt_llm_tts"
    ? "stt_llm_tts"
    : PIPELINE_MODE_RAW.includes("realtime")
      ? "realtime"
      : "realtime";

// Serveur HTTP explicite (meilleur contrôle + endpoint /health pour garder Render "chaud")
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  console.log("📥 HTTP Request:", req.method, req.url, "from", req.headers["user-agent"] || "unknown");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ws server");
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

const wss = new WebSocketServer({
  server,
  // IMPORTANT: désactiver la compression WS pour maximiser la compatibilité et accélérer le handshake
  perMessageDeflate: false,
});

server.listen(PORT, () => {
  console.log(`WS Media Stream server listening on :${PORT}`);
  console.log(`🌐 Server ready for WebSocket connections on port ${PORT}`);
  console.log(`🔗 WebSocket URL: wss://users-kendrikduflo-documents-autoguru-ws.onrender.com/stream`);
});

wss.on("connection", (ws, req) => {
  console.log("📞 New Media Stream connection:", req.url);
  console.log("📞 Headers:", JSON.stringify(req.headers, null, 2).substring(0, 500));
  
  // Extraire les paramètres de l'URL
  let callSid = null;
  let garageId = null;
  let garageName = "AutoGuru";
  let fromNumber = null;
  
  if (req.url) {
    console.log("🔍 URL complète:", req.url);
    const urlMatch = req.url.match(/\?([^#]*)/);
    if (urlMatch) {
      const queryString = urlMatch[1];
      console.log("🔍 Query string:", queryString);
      const params = new URLSearchParams(queryString);
      callSid = params.get("callSid");
      garageId = params.get("garageId");
      garageName = params.get("garageName") || "AutoGuru";
      fromNumber = params.get("fromNumber");
    } else {
      console.log("⚠️ Pas de query string dans l'URL");
    }
  } else {
    console.log("⚠️ req.url est null");
  }
  
  console.log("📞 Paramètres extraits:", { callSid, garageId, garageName, fromNumber });
  
  // Initialiser le temps de début d'appel
  callStartTimeMs = nowMs();
  
  let mediaCount = 0;
  let appendedBytes = 0; // bytes ajoutés depuis le dernier commit
  let openaiWs = null;
  let twilioStreamSid = null;
  // VAD local (Twilio ne fournit pas toujours un VAD fiable via OpenAI events)
  let speechActive = false;
  let lastSpeechTs = 0;
  let lastCommitAt = 0;
  let silenceFrames = 0; // frames consécutives "silence"
  let bytesSinceSpeechStart = 0;
  let responseInProgress = false;
  let activeResponseId = null;
  let lastCommittedAt = 0;
  let lastResponseCreatedAt = 0;
  let lastResponseCreateRequestedAt = 0;
  let userHasSpoken = false;
  let lastAssistantSpokenAt = 0;
  let lastAssistantSpokenResponseId = null;
  let lastSpokenCommitAt = 0;
  // Buffer des frames Twilio reçues avant que OpenAI WS soit "open"
  let preOpenFrames = []; // Array<{ audioBase64: string, mulawLen: number, ts: number }>
  let preOpenBytes = 0;
  // File d'attente audio vers Twilio (μ-law 8kHz). Twilio attend généralement des frames de 20ms = 160 bytes.
  let outboundQueue = []; // Array<Buffer>
  let outboundQueuedBytes = 0;
  let hasSentInitialGreeting = false;
  let initialAssistantGreetingText = "";
  let loggedFirstAudioDelta = false;
  let outboundTimer = null;
  let lastResponseAt = 0;
  let awaitingUserResponse = false;
  let droppedOutboundBytes = 0;
  // Debug VAD local (ne doit PAS impacter la logique OpenAI)
  let localDbgSpeechActive = false;

  // Empêcher l'assistant de parler pendant que le client parle (évite “il ne m’a pas laissé finir”).
  // On s'appuie sur un VAD local très simple (énergie μ-law).
  const OUTPUT_WAIT_FOR_USER_SILENCE = (process.env.OUTPUT_WAIT_FOR_USER_SILENCE ?? "true").toLowerCase() === "true";
  const OUTPUT_USER_SPEECH_THRESHOLD = Number(process.env.OUTPUT_USER_SPEECH_THRESHOLD ?? "2800");
  const OUTPUT_USER_SPEECH_FRAMES = Number(process.env.OUTPUT_USER_SPEECH_FRAMES ?? "6"); // ~120ms
  const OUTPUT_USER_SILENCE_THRESHOLD = Number(process.env.OUTPUT_USER_SILENCE_THRESHOLD ?? "1100");
  const OUTPUT_USER_SILENCE_FRAMES = Number(process.env.OUTPUT_USER_SILENCE_FRAMES ?? "18"); // ~360ms
  // N'autoriser une réponse IA que dans une fenêtre proche de la dernière prise de parole utilisateur
  const ASSISTANT_RESPONSE_WINDOW_MS = Number(process.env.ASSISTANT_RESPONSE_WINDOW_MS ?? "15000");
  const LOG_TTS = (process.env.LOG_TTS ?? "false").toLowerCase() === "true";
  const LOG_MINIMAX_CHUNKS = (process.env.LOG_MINIMAX_CHUNKS ?? "false").toLowerCase() === "true";
  const LOG_MINIMAX_CHUNK_EVERY = Number(process.env.LOG_MINIMAX_CHUNK_EVERY ?? "50");
  const LOG_TTS_VERBOSE = (process.env.LOG_TTS_VERBOSE ?? "false").toLowerCase() === "true";

  function ttsVerbose(...args) {
    if (LOG_TTS_VERBOSE) console.log(...args);
  }
  const LOG_MINIMAX_EVENTS = (process.env.LOG_MINIMAX_EVENTS ?? "false").toLowerCase() === "true";
  const LOG_TWILIO_FRAMES = (process.env.LOG_TWILIO_FRAMES ?? "false").toLowerCase() === "true";
  const LOG_VAD = (process.env.LOG_VAD ?? "false").toLowerCase() === "true";
  let outUserSpeechFrames = 0;
  let outUserSilenceFrames = 0;
  let outUserSpeaking = false;
  let pendingSpeakQueue = []; // textes ElevenLabs en attente pendant que le client parle

  // Realtime: STT local (Whisper) pour remplir les détails d'appel + réduire les confusions
  const REALTIME_USER_STT_ENABLED = (process.env.REALTIME_USER_STT_ENABLED ?? "true").toLowerCase() === "true";
  const REALTIME_USER_STT_SPEECH_THRESHOLD = Number(process.env.REALTIME_USER_STT_SPEECH_THRESHOLD ?? "1500");
  const REALTIME_USER_STT_SPEECH_FRAMES = Number(process.env.REALTIME_USER_STT_SPEECH_FRAMES ?? "6");
  const REALTIME_USER_STT_SILENCE_THRESHOLD = Number(process.env.REALTIME_USER_STT_SILENCE_THRESHOLD ?? "650");
  const REALTIME_USER_STT_SILENCE_FRAMES = Number(process.env.REALTIME_USER_STT_SILENCE_FRAMES ?? "22");
  const REALTIME_USER_STT_MIN_AUDIO_MS = Number(process.env.REALTIME_USER_STT_MIN_AUDIO_MS ?? "500");
  let rtSttSpeechFrames = 0;
  let rtSttSilenceFrames = 0;
  let rtSttActive = false;
  let rtSttStartedAt = 0;
  let rtSttMulawChunks = [];
  let rtSttInFlight = false;
  
  // Mode "voix premium" (TTS externe). Si activé, on ignore l'audio OpenAI et on lit une voix premium via TTS.
  const PREMIUM_TTS_ENABLED = (process.env.PREMIUM_TTS_ENABLED ?? "false").toLowerCase() === "true";
  const PREMIUM_TTS_PROVIDER = (process.env.PREMIUM_TTS_PROVIDER ?? "elevenlabs").toLowerCase();
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
  const ELEVENLABS_VOICE_ID_DEFAULT = process.env.ELEVENLABS_VOICE_ID ?? "";
  const ELEVENLABS_VOICE_ID_MALE = process.env.ELEVENLABS_VOICE_ID_MALE ?? "";
  const ELEVENLABS_VOICE_ID_FEMALE = process.env.ELEVENLABS_VOICE_ID_FEMALE ?? "";
  const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
  const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT ?? "pcm_16000";
  const ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = Number(process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY ?? "3"); // 0..4
  // Voice tuning (réduit l'accent "anglais" + rend plus naturel selon les voix)
  const ELEVENLABS_STABILITY = Number(process.env.ELEVENLABS_STABILITY ?? "0.55"); // 0..1
  const ELEVENLABS_SIMILARITY_BOOST = Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? "0.85"); // 0..1
  const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE ?? "0.35"); // 0..1
  const ELEVENLABS_USE_SPEAKER_BOOST = (process.env.ELEVENLABS_USE_SPEAKER_BOOST ?? "true").toLowerCase() === "true";
  
  // Configuration Minimax TTS
  const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";
  const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID ?? "";
  const MINIMAX_VOICE_ID_DEFAULT = process.env.MINIMAX_VOICE_ID ?? "";
  const MINIMAX_VOICE_ID_MALE = process.env.MINIMAX_VOICE_ID_MALE ?? "";
  const MINIMAX_VOICE_ID_FEMALE = process.env.MINIMAX_VOICE_ID_FEMALE ?? "";
  const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "speech-01"; // speech-01, speech-02, etc.
  const MINIMAX_SPEED = Number(process.env.MINIMAX_SPEED ?? "0.9"); // 0.5 à 2.0
  const MINIMAX_VOLUME = Number(process.env.MINIMAX_VOLUME ?? "1.0"); // 0.0 à 1.0
  const MINIMAX_PITCH = Number(process.env.MINIMAX_PITCH ?? "0"); // -12 à 12
  let premiumTtsAbort = null;
  let premiumTtsBypassUntilMs = 0; // si TTS premium échoue, on laisse passer l'audio OpenAI un moment
  let premiumTtsInFlight = false;
  let premiumTtsLastError = null;
  let premiumTtsQueue = []; // Array<{ text: string, interrupt: boolean }>
  let premiumTtsDrainInFlight = false;
  let premiumTtsLastText = ""; // Dernier texte effectivement envoyé au TTS (pour éviter les répétitions exactes)
  let spokenResponseIds = new Map(); // responseId -> timestamp (anti-répétitions par réponse)
  let recentAssistantTexts = []; // Array<{ text: string, ts: number }>
  const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS ?? "520");

  // AutoGuru ingest (pour remplir "détails d'appel" même en mode Realtime)
  // AutoGuru ingest: par défaut via env (legacy), mais en multi-garages on préfère
  // recevoir URL+token par appel via Twilio <Parameter> (verrouillé par garage).
  const AUTOGURU_INGEST_URL_ENV = process.env.AUTOGURU_INGEST_URL ?? ""; // ex: https://<autoguru>/api/twilio/realtime-ingest
  const AUTOGURU_INGEST_SECRET_ENV = process.env.AUTOGURU_INGEST_SECRET ?? "";
  let autoguruIngestUrl = "";
  let autoguruIngestToken = "";
  let clientInfo = null; // Infos client (nom, rendez-vous à venir)
  let assistantName = "Sandra";
  let assistantVoice = "female"; // "female" | "male"
  let garageTone = "";
  let consentRequired = true;
  let appointmentMode = "request";
  let garageClosed = false;
  let garageClosedReason = "";
  let garageClosedText = "";
  let garageHoursText = "";
  let availableAppointmentSlotsLine = "";
  let closedDaysText = ""; // Jours de fermeture hebdomadaires (ex: "Le garage est fermé le dimanche")
  let collectVehicleInfo = false;
  let pricingSummary = "";
  let servicesSummary = "";
  let faqsSummary = "";
  let ingestSeq = 0;
  let ingestChain = Promise.resolve();
  function enqueueIngest(role, text) {
    ingestSeq += 1;
    const seq = ingestSeq;
    const ts = nowMs();
    ingestChain = ingestChain
      .then(() => ingestToAutoGuru(role, text, { seq, ts }))
      .catch(() => {});
  }
  async function ingestToAutoGuru(role, text, extra = {}) {
    try {
      const url = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!url) return;
      if (!token && !secret) return;
      if (!callSid) return;
      const clean = String(text || "").trim();
      if (!clean) return;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          role,
          text: clean,
          garageId: garageId || null,
          fromNumber: fromNumber || null,
          ...extra,
        }),
      }).catch(() => {});
    } catch {
      // ignore
    }
  }

  let finalizeSent = false;
  async function finalizeCallToAutoGuru(reason = "stop") {
    try {
      if (finalizeSent) return;
      finalizeSent = true;
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return;
      if (!callSid) return;
      const finalizeUrl = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/realtime-finalize");
      await ingestChain.catch(() => {});
      await fetch(finalizeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          garageId: garageId || null,
          fromNumber: fromNumber || null,
          appointmentMode: appointmentMode || null,
          reason,
        }),
      }).catch(() => {});
      console.log("🧾 Finalize envoyé à AutoGuru.", { reason });
    } catch {
      // ignore
    }
  }

  async function triggerHangup(reason = "auto") {
    try {
      if (!callSid) return;
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return;
      const hangupUrl = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/hangup");
      await fetch(hangupUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          garageId: garageId || null,
          reason,
        }),
      }).catch((err) => {
        console.error("❌ Erreur lors de l'envoi du hangup:", err);
      });
      console.log("📞 Hangup demandé à AutoGuru.", { reason });
    } catch (err) {
      console.error("❌ Erreur triggerHangup:", err);
    }
  }

  async function requestPlateSmsIfNeeded(trigger = "assistant_plate_request") {
    try {
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return { sent: false, reason: "no_ingest_url" };
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return { sent: false, reason: "no_auth" };
      if (!callSid) return { sent: false, reason: "no_callsid" };
      const to = String(fromNumber || "").trim();
      if (!/^\+\d{8,15}$/.test(to)) return { sent: false, reason: "invalid_phone" };

      // Anti-spam: une fois par appel
      if (ws.__plateSmsRequested) return { sent: false, reason: "already_requested" };
      ws.__plateSmsRequested = true;

      const url = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/plate-sms/request");
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          garageId: garageId || null,
          fromNumber: to,
          trigger,
        }),
      }).catch(() => null);
      if (resp && resp.ok) {
        const json = await resp.json().catch(() => ({}));
        // Si le client existe déjà avec une plaque, ne pas envoyer le SMS
        if (json?.skipped === "client_has_plate" && json?.existingPlate) {
          console.log("📩 Client existe avec plaque, SMS non envoyé.", { 
            trigger, 
            existingPlate: json.existingPlate,
            clientName: json.clientName,
            callSid,
            fromNumber: to,
            garageId: garageId || null
          });
          try {
            if (!clientInfo) clientInfo = {};
            clientInfo.plate = json.existingPlate;
          } catch {}
          enqueueIngest("assistant", `Plaque client existante: ${json.existingPlate}.`);
          // L'IA devra demander confirmation de la plaque au lieu d'envoyer le SMS
          enqueueElevenLabsTts(
            `Je vois que vous êtes déjà dans nos dossiers. Votre plaque d'immatriculation est ${json.existingPlate}. Est-ce bien correct ?`,
            { interrupt: true }
          );
          return { sent: false, skipped: true, reason: "client_has_plate", existingPlate: json.existingPlate };
        }
        const smsSid = json?.smsSid ?? null;
        const isSent = Boolean(smsSid || json?.status === "sent");
        if (!isSent) {
          console.warn("⚠️ SMS plaque: réponse OK mais pas de smsSid", { trigger, json });
          enqueueElevenLabsTts(
            "Désolé, le SMS n'est pas parti. Je vais vous l'envoyer dès que possible. Vous pourrez répondre par SMS avec votre plaque.",
            { interrupt: true },
          );
          return { sent: false, reason: "no_sms_sid" };
        }
        console.log("📩 SMS plaque demandé à AutoGuru.", { 
          trigger, 
          smsSid,
          callSid,
          fromNumber: to,
          garageId: garageId || null,
          url
        });
        return { sent: true, smsSid };
      } else if (resp) {
        const t = await resp.text().catch(() => "");
        console.warn("⚠️ SMS plaque request non-ok:", { status: resp.status, trigger, body: t.slice(0, 180) });
        // Fallback UX: si le SMS ne peut pas partir, on informe sans demander la plaque à l'oral
        enqueueElevenLabsTts(
          "Désolé, le SMS n'est pas parti. Je vais vous l'envoyer dès que possible. Vous pourrez répondre par SMS avec votre plaque.",
          { interrupt: true },
        );
        return { sent: false, reason: "http_error", status: resp.status };
      } else {
        console.warn("⚠️ SMS plaque request: aucune réponse (fetch échoué).", { trigger });
        enqueueElevenLabsTts(
          "Petit souci d’envoi du SMS. Je vais vous l'envoyer dès que possible. Vous pourrez répondre par SMS avec votre plaque.",
          { interrupt: true },
        );
        return { sent: false, reason: "fetch_failed" };
      }
    } catch {
      return { sent: false, reason: "exception" };
    }
  }

  async function fetchAvailableAppointmentSlots() {
    try {
      if (appointmentMode !== "internal") return [];
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return [];
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return [];
      if (!garageId) return [];
      const url = String(ingestUrl).replace(
        /\/api\/twilio\/realtime-ingest\/?$/i,
        "/api/twilio/appointments/available",
      );
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          garageId: garageId || null,
          daysAhead: 10,
        }),
      }).catch(() => null);
      if (!resp || !resp.ok) return [];
      const json = await resp.json().catch(() => ({}));
      const slots = Array.isArray(json?.slots) ? json.slots : [];
      return slots
        .map((s) => ({
          date: String(s?.date || "").trim(),
          time: String(s?.time || "").trim(),
        }))
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{2}:\d{2}$/.test(s.time));
    } catch {
      return [];
    }
  }

  // --- SMS plaque : envoi automatique à la fin de l'appel (pas de consentement requis) ---
  let plateSmsWaitingForReply = false;
  let plateSmsPollTimer = null;
  let plateSmsSendOnFinalize = false;

  // --- Hangup automatique après au revoir ---
  let goodbyeDetected = false;
  let goodbyeTimer = null;
  let lastUserActivityMs = 0;
  let callStartTimeMs = 0;
  const GOODBYE_DELAY_MS = 5000; // 5 secondes après l'au revoir pour couper l'appel
  const MIN_CALL_DURATION_MS = 30000; // Minimum 30 secondes d'appel avant hangup automatique
  const MIN_USER_INACTIVITY_MS = 5000; // Client doit être inactif depuis au moins 5 secondes

  function isAffirmativeFr(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return /\b(oui|ouais|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche)\b/.test(t);
  }
  function isNegativeFr(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return /\b(non|pas du tout|nan|nann|nope|laisse tomber)\b/.test(t);
  }

  function isJunkTranscript(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return true;
    // TV / sous-titres / disclaimers
    if (t.includes("amara.org") || t.includes("sous-titres") || t.includes("sous titres")) return true;
    if (t.includes("réalisés par la communauté")) return true;
    // bruit très court
    const stripped = t.replace(/[\s\p{P}\p{S}]/gu, "");
    if (stripped.length < 2) return true;
    return false;
  }

  async function pollPlateSmsStatus() {
    try {
      if (!plateSmsWaitingForReply) return;
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return;
      if (!callSid) return;
      const url = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/plate-sms/status");
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          garageId: garageId || null,
        }),
      }).catch(() => null);
      if (!resp || !resp.ok) return;
      const json = await resp.json().catch(() => ({}));
      const plate = String(json?.plate || "").trim();
      const received = !!plate;
      if (!received) return;

      // Stop polling
      plateSmsWaitingForReply = false;
      if (plateSmsPollTimer) {
        clearInterval(plateSmsPollTimer);
        plateSmsPollTimer = null;
      }

      // Mettre à jour les infos client / détails d'appel
      try {
        if (!clientInfo) clientInfo = {};
        clientInfo.plate = plate;
      } catch {}
      enqueueIngest("assistant", `Plaque reçue par SMS: ${plate}.`);

      // Dire au client qu'on a bien reçu la plaque, puis continuer
      const confirmText = `Parfait, j'ai bien reçu votre plaque ${plate}. Merci. Je continue maintenant.`;
      enqueueElevenLabsTts(confirmText, { interrupt: true });
      // Et l'ajouter au contexte OpenAI pour que la suite en tienne compte
      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Plaque reçue par SMS: ${plate}. Continue la conversation.` }],
            },
          }));
        }
      } catch {}
    } catch {
      // ignore
    }
  }
  // Option B (STT → LLM → TTS)
  const STT_MODEL = process.env.STT_MODEL ?? "whisper-1";
  const STT_LANGUAGE = process.env.STT_LANGUAGE ?? "fr";
  // Prompt Whisper: améliore la compréhension en téléphonie (vocabulaire garage + formats plaques)
  const STT_PROMPT = process.env.STT_PROMPT ?? "Garage auto, pièces: vidange, freins, plaquettes, disques, embrayage, courroie de distribution, pneus, climatisation, diagnostic. Plaques françaises: AB-123-CD. Le client parle français.";
  const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o";
  // Réglages "fast-by-default" pour réduire la latence perçue
  const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? "0.3");
  const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? "160");
  // Valeurs par défaut plus tolérantes (meilleure compréhension si voix faible)
  const STT_SPEECH_THRESHOLD = Number(process.env.STT_SPEECH_THRESHOLD ?? "1500");
  const STT_SPEECH_FRAMES = Number(process.env.STT_SPEECH_FRAMES ?? "6"); // ~120ms
  // IMPORTANT: trop agressif => coupe la phrase dès une micro-pause.
  // On baisse le seuil de "silence" et on augmente la durée de silence requise.
  const STT_SILENCE_THRESHOLD = Number(process.env.STT_SILENCE_THRESHOLD ?? "650");
  const STT_SILENCE_FRAMES = Number(process.env.STT_SILENCE_FRAMES ?? "24"); // ~480ms
  const STT_MIN_AUDIO_MS = Number(process.env.STT_MIN_AUDIO_MS ?? "550");
  const HISTORY_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS ?? "8");
  const BACKCHANNEL_ENABLED = (process.env.BACKCHANNEL_ENABLED ?? "true").toLowerCase() === "true";
  const BACKCHANNEL_TEXT = process.env.BACKCHANNEL_TEXT ?? "D'accord, je note…";
  const BACKCHANNEL_DELAY_MS = Number(process.env.BACKCHANNEL_DELAY_MS ?? "1500");
  const BACKCHANNEL_MIN_INTERVAL_MS = Number(process.env.BACKCHANNEL_MIN_INTERVAL_MS ?? "20000");
  // Timeout global (ms). GPT‑5 peut être plus lent: on ajuste dynamiquement (voir openaiLLM).
  const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? "15000");
  let backchannelTimer = null;
  let lastBackchannelAt = 0;
  let llmInFlight = false;
  // Realtime latency tuning
  const RESPONSE_CREATE_DEBOUNCE_MS = Number(process.env.RESPONSE_CREATE_DEBOUNCE_MS ?? "400");
  const WATCHDOG_AFTER_COMMIT_MS = Number(process.env.WATCHDOG_AFTER_COMMIT_MS ?? "250");
  let sttSpeechFrames = 0;
  let sttSilenceFrames = 0;
  let sttActive = false;
  let sttBytes = 0;
  let sttStartedAt = 0;
  let sttMulawChunks = []; // Array<Buffer>
  let sttInFlight = false;
  let conversationHistory = []; // Array<{role:'user'|'assistant', content:string}>

  function logPipelineConfigOnce(prefix = "⚙️ Config") {
    try {
      console.log(prefix, {
        PIPELINE_MODE,
        PIPELINE_MODE_RAW,
        PREMIUM_TTS_ENABLED,
        REALTIME_TTS_MODE,
        ELEVENLABS_MODEL_ID,
        ELEVENLABS_OUTPUT_FORMAT,
        ELEVENLABS_OPTIMIZE_STREAMING_LATENCY,
        BACKCHANNEL_ENABLED,
        BACKCHANNEL_TEXT,
        LLM_MODEL,
        STT_MODEL,
        STT_LANGUAGE,
        // indicateurs utiles de latence
        STT_SILENCE_FRAMES,
        STT_MIN_AUDIO_MS,
      });
    } catch {
      // ignore
    }
  }

  function nowMs() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resample8kTo16k(pcm8k) {
    // x2 avec interpolation linéaire simple
    const out = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length; i++) {
      const s0 = pcm8k[i];
      const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
      out[i * 2] = s0;
      out[i * 2 + 1] = ((s0 + s1) / 2) | 0;
    }
    return out;
  }

  function mulaw8kToPcm16kWav(mulawBuf) {
    // Decode μ-law -> PCM 8k
    const pcm8k = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) {
      pcm8k[i] = MULAW_DECODE_TABLE[mulawBuf[i] & 0xff];
    }
    const pcm16k = resample8kTo16k(pcm8k);

    const dataSize = pcm16k.length * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16); // PCM
    wav.writeUInt16LE(1, 20); // format
    wav.writeUInt16LE(1, 22); // channels
    wav.writeUInt32LE(16000, 24); // sample rate
    wav.writeUInt32LE(16000 * 2, 28); // byte rate
    wav.writeUInt16LE(2, 32); // block align
    wav.writeUInt16LE(16, 34); // bits
    wav.write("data", 36);
    wav.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < pcm16k.length; i++) {
      wav.writeInt16LE(pcm16k[i], 44 + i * 2);
    }
    return wav;
  }

  async function openaiTranscribeWav(wavBuffer) {
    const form = new FormData();
    form.append("model", STT_MODEL);
    form.append("language", STT_LANGUAGE);
    form.append("response_format", "json");
    if (STT_PROMPT && String(STT_PROMPT).trim()) {
      form.append("prompt", String(STT_PROMPT).trim());
    }
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: form,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`STT error ${resp.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return (json.text ?? "").toString();
  }

  function extractTextFromResponsesJson(json) {
    if (!json) return "";
    if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
    // fallback: parcourir output[]
    const out = Array.isArray(json.output) ? json.output : [];
    const parts = [];
    for (const item of out) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        const t = c?.text ?? c?.transcript ?? c?.value ?? c?.output_text ?? null;
        if (typeof t === "string" && t.trim()) parts.push(t.trim());
      }
    }
    return parts.join("\n").trim();
  }

  function buildPromptFromMessages(messages) {
    // Transforme l'historique en un seul texte (robuste pour l'API Responses).
    const lines = [];
    for (const m of messages || []) {
      const role = String(m?.role ?? "user");
      const content = String(m?.content ?? "").trim();
      if (!content) continue;
      if (role === "system") continue;
      const label = role === "assistant" ? "Assistant" : "Client";
      lines.push(`${label}: ${content}`);
    }
    lines.push("Assistant:");
    return lines.join("\n");
  }

  async function openaiLLM(messages, model) {
    const isGpt5 = String(model).toLowerCase().includes("gpt-5");
    const controller = new AbortController();
    // GPT‑5 peut dépasser 12s en prod; on donne un budget plus large pour éviter le fallback permanent.
    const timeoutMs = isGpt5 ? Math.max(45_000, LLM_TIMEOUT_MS) : LLM_TIMEOUT_MS;
    if (isGpt5) {
      console.log("⏱️ LLM timeout (gpt-5):", { timeoutMs });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // GPT‑5: utiliser Responses API (les params et endpoints diffèrent)
      if (isGpt5) {
        const systemMsg = (messages || []).find((m) => m?.role === "system")?.content ?? "";
        const prompt = buildPromptFromMessages(messages);
        const body = {
          model,
          input: String(prompt),
          instructions: String(systemMsg || ""),
          // Paramètre correct côté Responses API
          max_output_tokens: LLM_MAX_TOKENS,
        };
        // temperature: gpt-5 semble refuser autre chose que la valeur par défaut; on omet.
        if (Number(LLM_TEMPERATURE) === 1) body.temperature = 1;

        const resp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify(body),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          const msg = JSON.stringify(json).slice(0, 400);
          const err = new Error(`LLM error ${resp.status}: ${msg}`);
          err.__openai = json;
          throw err;
        }
        const text = extractTextFromResponsesJson(json);
        if (!text) {
          console.warn("⚠️ GPT-5 réponse vide (Responses).", {
            keys: Object.keys(json || {}).slice(0, 20),
            outputLen: Array.isArray(json?.output) ? json.output.length : null,
          });
        }
        return text;
      }

      // Autres modèles: Chat Completions
      const body = {
        model,
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        messages,
      };
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = JSON.stringify(json).slice(0, 400);
        const err = new Error(`LLM error ${resp.status}: ${msg}`);
        err.__openai = json;
        throw err;
      }
      const content = json?.choices?.[0]?.message?.content ?? "";
      return String(content || "").trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runSttLlmTtsTurn() {
    if (sttInFlight) return;
    if (!OPENAI_API_KEY) return;
    if (!PREMIUM_TTS_ENABLED) {
      console.warn("⚠️ PIPELINE_MODE=stt_llm_tts mais PREMIUM_TTS_ENABLED=false (pas de voix).");
    }
    const joined = sttMulawChunks.length ? Buffer.concat(sttMulawChunks) : Buffer.alloc(0);
    sttMulawChunks = [];
    sttBytes = 0;
    sttInFlight = true;
    try {
      const wav = mulaw8kToPcm16kWav(joined);
      const transcript = (await openaiTranscribeWav(wav)).trim();
      if (!transcript) return;
      // Ignore les transcriptions trop courtes / ponctuation seule (évite "!" → tours inutiles)
      const cleaned = transcript.replace(/[\s'’"“”]/g, "").trim();
      if (cleaned.length < 3 || /^[\p{P}\p{S}]+$/u.test(cleaned)) {
        console.log("🧹 STT ignoré (trop court/bruit):", { transcript });
        return;
      }
      console.log("🎤 STT:", transcript);

      // Historique (limité)
      conversationHistory.push({ role: "user", content: transcript });
      conversationHistory = conversationHistory.slice(-HISTORY_MAX_TURNS * 2);

      const system = `Tu es le standard téléphonique d'un garage. Français (France).
Réponses très naturelles, chaleureuses, courtes, avec une intonation humaine (sans mentionner l'IA).
Pose 1 question à la fois. Ne répète pas "bonjour" si déjà dit dans l'appel.`;

      const msgs = [
        { role: "system", content: system },
        ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
      ];

      let answer = "";
      try {
        llmInFlight = true;
        // Backchannel intelligent: uniquement si le LLM n'a pas répondu après un délai.
        if (BACKCHANNEL_ENABLED && PREMIUM_TTS_ENABLED) {
          const now = nowMs();
          const canPlay = (now - lastBackchannelAt) >= BACKCHANNEL_MIN_INTERVAL_MS;
          if (canPlay) {
            if (backchannelTimer) clearTimeout(backchannelTimer);
            backchannelTimer = setTimeout(() => {
              if (!llmInFlight) return;
              if (premiumTtsInFlight) return;
              lastBackchannelAt = nowMs();
              console.log("🗣️ Backchannel:", { text: BACKCHANNEL_TEXT });
              enqueueElevenLabsTts(BACKCHANNEL_TEXT, { interrupt: true });
            }, BACKCHANNEL_DELAY_MS);
          }
        }
        console.log("🧠 LLM start:", { model: LLM_MODEL });
        answer = await openaiLLM(msgs, LLM_MODEL);
        console.log("🧠 LLM done:", { model: LLM_MODEL, chars: answer?.length ?? 0 });
      } catch (err) {
        // Fallback si le modèle demandé (ex: gpt-5) n'est pas disponible
        console.error("❌ LLM primary failed, fallback to gpt-4o:", String(err?.message ?? err));
        console.warn("⚠️ FALLBACK LLM ACTIVÉ: " + LLM_MODEL + " → gpt-4o (réponses moins bonnes)");
        console.log("🧠 LLM start (fallback):", { model: "gpt-4o" });
        answer = await openaiLLM(msgs, "gpt-4o");
        console.log("🧠 LLM done (fallback):", { model: "gpt-4o", chars: answer?.length ?? 0 });
      } finally {
        llmInFlight = false;
        if (backchannelTimer) {
          clearTimeout(backchannelTimer);
          backchannelTimer = null;
        }
      }
      if (!answer) {
        // Si GPT‑5 renvoie vide, on fallback immédiatement pour ne pas laisser l'appel "sans réponse".
        console.warn("⚠️ LLM réponse vide, fallback gpt-4o.");
        console.warn("⚠️ FALLBACK LLM ACTIVÉ: " + LLM_MODEL + " a renvoyé vide → gpt-4o (réponses moins bonnes)");
        console.log("🧠 LLM start (fallback-empty):", { model: "gpt-4o" });
        answer = await openaiLLM(msgs, "gpt-4o");
        console.log("🧠 LLM done (fallback-empty):", { model: "gpt-4o", chars: answer?.length ?? 0 });
      }
      if (!answer) return;
      conversationHistory.push({ role: "assistant", content: answer });
      conversationHistory = conversationHistory.slice(-HISTORY_MAX_TURNS * 2);

      enqueueElevenLabsTts(answer, { interrupt: true });
    } catch (err) {
      console.error("❌ Erreur pipeline STT→LLM→TTS:", err);
    } finally {
      sttInFlight = false;
    }
  }

  async function speakWithMinimaxNow(text, { interrupt = true } = {}) {
    // LOG TRÈS VISIBLE au tout début pour tracer chaque appel (avec et sans emojis pour compatibilité)
    const rawText = String(text || "").substring(0, 200);
    const lastTextPreview = premiumTtsLastText ? premiumTtsLastText.substring(0, 50) : "null";
    if (LOG_TTS) {
      console.log(`[TTS-MINIMAX] ENTRÉE [interrupt=${interrupt}] [inFlight=${premiumTtsInFlight}] [lastText=${lastTextPreview}]`);
      console.log(`[TTS-MINIMAX] TEXTE:`, rawText);
      console.log(`🚨🚨🚨 speakWithMinimaxNow ENTRÉE (raw text):`, rawText);
      console.log(`🚨🚨🚨 speakWithMinimaxNow ENTRÉE (interrupt=${interrupt}, inFlight=${premiumTtsInFlight}, lastText=${lastTextPreview})`);
    }
    
    if (!PREMIUM_TTS_ENABLED) {
      if (LOG_TTS) {
        console.log(`[TTS-MINIMAX] SORTIE: PREMIUM_TTS_ENABLED=false`);
        console.log(`🚨 speakWithMinimaxNow SORTIE: PREMIUM_TTS_ENABLED=false`);
      }
      return;
    }
    if (PREMIUM_TTS_PROVIDER !== "minimax") {
      if (LOG_TTS) {
        console.log(`[TTS-MINIMAX] SORTIE: PREMIUM_TTS_PROVIDER=${PREMIUM_TTS_PROVIDER} !== minimax`);
        console.log(`🚨 speakWithMinimaxNow SORTIE: PREMIUM_TTS_PROVIDER=${PREMIUM_TTS_PROVIDER} !== minimax`);
      }
      return;
    }
    if (nowMs() < premiumTtsBypassUntilMs) {
      if (LOG_TTS) {
        console.log(`[TTS-MINIMAX] SORTIE: bypass actif jusqu'à ${premiumTtsBypassUntilMs}`);
        console.log(`🚨 speakWithMinimaxNow SORTIE: bypass actif jusqu'à ${premiumTtsBypassUntilMs}`);
      }
      return;
    }
    const selectedVoiceId =
      assistantVoice === "male"
        ? (MINIMAX_VOICE_ID_MALE || MINIMAX_VOICE_ID_DEFAULT)
        : (MINIMAX_VOICE_ID_FEMALE || MINIMAX_VOICE_ID_DEFAULT);
    if (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID || !selectedVoiceId) {
      console.error("❌ PREMIUM_TTS activé mais MINIMAX_API_KEY/MINIMAX_GROUP_ID/MINIMAX_VOICE_ID manquants.");
      premiumTtsLastError = "Configuration Minimax incomplète";
      premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000; // 5 min de bypass
      return;
    }
    const clean = normalizeFrenchTtsText((text || "").trim());
    if (!clean) return;

    // Éviter de rejouer exactement la même phrase (même si elle arrive via différents événements)
    const normalizedForCompare = clean.toLowerCase().replace(/[.,!?;:]/g, "").trim();
    if (premiumTtsLastText) {
      const lastNormalized = normalizeFrenchTtsText(premiumTtsLastText).toLowerCase().replace(/[.,!?;:]/g, "").trim();
      if (lastNormalized === normalizedForCompare && premiumTtsInFlight) {
        if (LOG_TTS) {
          console.log(`[TTS-MINIMAX] IGNORÉ (même texte en cours de synthèse):`, clean.substring(0, 120));
          console.log(`🔁 speakWithMinimaxNow ignoré (même texte en cours de synthèse):`, clean.substring(0, 120));
        }
        return;
      }
    }

    if (LOG_TTS) {
      console.log(`[TTS-MINIMAX] APPELÉ (démarrage synthèse):`, clean.substring(0, 120));
      console.log(`🎤 speakWithMinimaxNow appelé:`, clean.substring(0, 120));
    }
    premiumTtsLastText = clean;

    // Stopper toute synthèse en cours et couper l'audio en file
    if (interrupt) {
      try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
      premiumTtsAbort = new AbortController();
      outboundQueue = [];
      outboundQueuedBytes = 0;
    } else if (!premiumTtsAbort) {
      premiumTtsAbort = new AbortController();
    }
    premiumTtsInFlight = true;
    premiumTtsLastError = null;

    let minimaxWs = null;
    try {
      // API Minimax TTS WebSocket selon la documentation: https://platform.minimax.io/docs/guides/speech-t2a-websocket
      // Ajouter GroupId dans l'URL si disponible
      let wsUrl = "wss://api.minimax.io/ws/v1/t2a_v2";
      if (MINIMAX_GROUP_ID) {
        wsUrl += `?GroupId=${encodeURIComponent(MINIMAX_GROUP_ID)}`;
      }
      const apiKey = MINIMAX_API_KEY.startsWith("Bearer ") ? MINIMAX_API_KEY.substring(7) : MINIMAX_API_KEY;
      
      if (LOG_MINIMAX_EVENTS) {
        console.log("🔌 Connexion Minimax WebSocket...", { url: wsUrl.replace(/GroupId=[^&]+/, "GroupId=***") });
      }
      minimaxWs = new WebSocket(wsUrl, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });

      // Queue pour les messages entrants
      const messageQueue = [];
      let messageResolver = null;

      minimaxWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (LOG_MINIMAX_EVENTS) {
            console.log("📨 Minimax message:", msg.event || "unknown", Object.keys(msg));
          }
          
          if (messageResolver) {
            messageResolver(msg);
            messageResolver = null;
          } else {
            messageQueue.push(msg);
          }
        } catch (e) {
          console.error("❌ Erreur parsing message Minimax:", e);
        }
      });

      // Attendre la connexion
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timeout connexion Minimax WebSocket (10s)"));
        }, 10000);
        
        minimaxWs.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });
        
        minimaxWs.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Attendre le message "connected_success"
      const waitForMessage = (eventName, timeoutMs = 5000) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timeout attente ${eventName}`));
          }, timeoutMs);
          
          const checkQueue = () => {
            const msg = messageQueue.shift();
            if (msg && msg.event === eventName) {
              clearTimeout(timeout);
              resolve(msg);
            } else if (msg) {
              // Message inattendu, le remettre en queue et continuer à attendre
              messageQueue.unshift(msg);
              messageResolver = (msg) => {
                if (msg.event === eventName) {
                  clearTimeout(timeout);
                  resolve(msg);
                } else {
                  messageQueue.push(msg);
                  checkQueue();
                }
              };
            } else {
              messageResolver = (msg) => {
                if (msg.event === eventName) {
                  clearTimeout(timeout);
                  resolve(msg);
                } else {
                  messageQueue.push(msg);
                  checkQueue();
                }
              };
            }
          };
          
          checkQueue();
        });
      };

      const connectedMsg = await waitForMessage("connected_success");
      if (LOG_MINIMAX_EVENTS) console.log("✅ Minimax WebSocket connecté:", connectedMsg);

      // Démarrer la tâche TTS
      // Selon la doc Minimax WebSocket, les modèles supportés sont:
      // - speech-2.6-hd
      // - speech-2.6-turbo
      // - speech-02-hd
      // - speech-02-turbo
      // Le modèle "speech-01" n'est PAS supporté pour l'API WebSocket t2a_v2
      const taskStartMsg = {
        event: "task_start",
        model: MINIMAX_MODEL || "speech-2.6-hd", // Utiliser un modèle supporté pour WebSocket
        voice_setting: {
          voice_id: selectedVoiceId,
          // Ralentir légèrement la cadence par défaut pour un rendu plus humain
          speed: Math.max(0.5, Math.min(2.0, MINIMAX_SPEED || 0.85)),
          vol: Math.max(0.0, Math.min(1.0, MINIMAX_VOLUME || 1.0)),
          pitch: Math.max(-12, Math.min(12, MINIMAX_PITCH || 0)),
          english_normalization: false,
        },
        audio_setting: {
          sample_rate: 32000, // 32kHz (Minimax semble ignorer 8kHz, on fait le downsampling nous-mêmes)
          bitrate: 128000, // Bitrate pour 32kHz
          format: "pcm", // Format PCM (selon la doc: mp3, pcm, flac sont supportés)
          channel: 1,
        },
      };

      if (LOG_MINIMAX_EVENTS) console.log("📤 Envoi task_start:", JSON.stringify(taskStartMsg, null, 2));
      minimaxWs.send(JSON.stringify(taskStartMsg));

      // Attendre "task_started"
      const taskStartedMsg = await waitForMessage("task_started");
      if (LOG_MINIMAX_EVENTS) console.log("✅ Tâche Minimax démarrée:", taskStartedMsg);

      // Envoyer le texte
      const continueMsg = {
        event: "task_continue",
        text: clean,
      };
      if (LOG_MINIMAX_EVENTS) console.log("📤 Envoi task_continue:", { textLength: clean.length });
      minimaxWs.send(JSON.stringify(continueMsg));

      // Collecter l'audio en streaming - écouter tous les messages
      let audioData = Buffer.alloc(0);
      let chunkCounter = 0;
      let isFinal = false;
      let lastMessageTime = nowMs();

      while (!isFinal && !premiumTtsAbort.signal.aborted) {
        const msg = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            const elapsed = nowMs() - lastMessageTime;
            reject(new Error(`Timeout attente réponse Minimax (${elapsed}ms depuis dernier message)`));
          }, 30000);
          
          const checkForMessage = () => {
            if (messageQueue.length > 0) {
              clearTimeout(timeout);
              const msg = messageQueue.shift();
              lastMessageTime = nowMs();
              resolve(msg);
            } else {
              messageResolver = (msg) => {
                clearTimeout(timeout);
                lastMessageTime = nowMs();
                resolve(msg);
              };
            }
          };
          
          checkForMessage();
        });

        if (LOG_MINIMAX_EVENTS) {
          console.log("📨 Minimax réponse:", msg.event || "data", {
            hasData: !!(msg.data),
            hasAudio: !!(msg.data && msg.data.audio),
            isFinal: msg.is_final,
            audioLength: msg.data?.audio ? msg.data.audio.length : 0,
          });
        }
        
        if (msg.data && msg.data.audio) {
          // Audio en hexadécimal selon la doc
          const audioHex = msg.data.audio;
          const audioBytes = Buffer.from(audioHex, "hex");
          audioData = Buffer.concat([audioData, audioBytes]);
          chunkCounter++;
          
          if (LOG_MINIMAX_CHUNKS && (chunkCounter % LOG_MINIMAX_CHUNK_EVERY === 0 || msg.is_final)) {
            console.log(`🎵 Minimax audio chunk ${chunkCounter}:`, { 
              hexLength: audioHex.length, 
              bytesLength: audioBytes.length 
            });
          }
          
          // Si le format est MP3, on doit le décoder en PCM16
          // Pour l'instant, on accumule tous les chunks MP3 et on les décode à la fin
          // (décodage MP3 nécessiterait une bibliothèque externe comme ffmpeg)
          // Solution temporaire: utiliser wav si disponible, sinon on devra décoder MP3
        }

        if (msg.is_final || msg.event === "task_finished") {
          isFinal = true;
          console.log(`✅ Minimax TTS terminé: ${chunkCounter} chunks, ${audioData.length} bytes`);
          
          // Décoder le PCM brut en PCM16
          // Minimax retourne généralement du PCM à 32kHz même si on demande 8kHz
          // On détecte automatiquement le sample rate en fonction de la taille des données
          if (audioData.length > 0) {
            try {
          if (LOG_MINIMAX_EVENTS) console.log(`🎵 Décodage PCM: ${audioData.length} bytes`);
              
              // Le format "pcm" retourne du PCM16 brut (pas de header WAV/MP3)
              // Convertir directement en Int16Array
              const pcmRaw = new Int16Array(
                audioData.buffer,
                audioData.byteOffset,
                audioData.length / 2,
              );
              
              // Détecter le sample rate : si on a demandé 8kHz mais Minimax retourne beaucoup de samples,
              // c'est probablement du 32kHz. On utilise le ratio attendu pour déterminer.
              // Pour une phrase de ~2 secondes à 8kHz: ~16000 samples
              // Pour une phrase de ~2 secondes à 32kHz: ~64000 samples
              // Si on a plus de 20000 samples, c'est probablement du 32kHz
              const expectedSampleRate = (pcmRaw.length > 20000) ? 32000 : 8000;
              if (LOG_MINIMAX_EVENTS) {
                console.log(`🎵 PCM reçu: ${pcmRaw.length} samples (détecté: ${expectedSampleRate}Hz)`);
              }
              
              let mulaw;
              if (expectedSampleRate === 32000) {
                // Downsampler de 32kHz à 8kHz (1 sur 4)
                mulaw = convertPcm32kToMulaw(pcmRaw);
                if (LOG_MINIMAX_EVENTS) {
                  console.log(`🎵 Downsampled: ${pcmRaw.length} samples @ 32kHz → ${mulaw.length} samples @ 8kHz`);
                }
              } else {
                // Déjà à 8kHz, conversion directe
                mulaw = convertPcm8kToMulaw(pcmRaw);
                console.log(`🎵 Converti: ${pcmRaw.length} samples @ 8kHz → ${mulaw.length} samples μ-law`);
              }
              
              // Envoyer par chunks de 20ms (160 bytes à 8kHz)
              const chunkSize = 160;
              for (let i = 0; i < mulaw.length; i += chunkSize) {
                const chunk = mulaw.slice(i, i + chunkSize);
                const mulawBuf = Buffer.from(chunk);
                enqueueOutboundMulaw(mulawBuf);
                // Petite pause pour éviter de surcharger
                if (i % (chunkSize * 10) === 0) {
                  await sleep(5);
                }
              }
              
              console.log(`🎙️ Minimax TTS audio envoyé: ${Math.ceil(mulaw.length / chunkSize)} chunks`);
            } catch (err) {
              console.error("❌ Erreur décodage PCM:", err);
              throw err;
            }
          }
        }
        
        if (msg.event === "task_failed") {
          throw new Error(`Minimax TTS failed: ${msg.error || JSON.stringify(msg)}`);
        }
      }

      // Fermer la connexion
      minimaxWs.send(JSON.stringify({ event: "task_finish" }));
      minimaxWs.close();

      // Si Minimax fonctionne, on réinitialise le fallback
      if (premiumTtsBypassUntilMs > 0) {
        console.log("✅ Minimax fonctionne → réinitialisation du fallback");
        premiumTtsBypassUntilMs = 0;
        premiumTtsLastError = null;
      }
      premiumTtsInFlight = false;
    } catch (err) {
      premiumTtsInFlight = false;
      if (minimaxWs) {
        try {
          minimaxWs.close();
        } catch {}
      }
      if (err.name === "AbortError") {
        console.log("🛑 Minimax TTS annulé (interrupt)");
        return;
      }
      const errorMsg = err?.message || String(err);
      console.error("❌ Erreur Minimax TTS WebSocket:", errorMsg);
      premiumTtsLastError = errorMsg;
      // En cas d'erreur rate limit, attendre 60 secondes avant de réessayer
      if (errorMsg.includes("rate limit") || errorMsg.includes("1002")) {
        premiumTtsBypassUntilMs = nowMs() + 60 * 1000; // 1 min pour rate limit
        console.log("⏳ Rate limit Minimax → attente 60s");
      } else {
        premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000; // 5 min pour autres erreurs
      }
    }
  }

  async function speakWithElevenLabsNow(text, { interrupt = true } = {}) {
    if (!PREMIUM_TTS_ENABLED) return;
    if (PREMIUM_TTS_PROVIDER !== "elevenlabs") return;
    if (nowMs() < premiumTtsBypassUntilMs) return;
    const selectedVoiceId =
      assistantVoice === "male"
        ? (ELEVENLABS_VOICE_ID_MALE || ELEVENLABS_VOICE_ID_DEFAULT)
        : (ELEVENLABS_VOICE_ID_FEMALE || ELEVENLABS_VOICE_ID_DEFAULT);
    if (!ELEVENLABS_API_KEY || !selectedVoiceId) {
      console.error("❌ PREMIUM_TTS activé mais ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID manquants.");
      return;
    }
    const clean = normalizeFrenchTtsText((text || "").trim());
    if (!clean) return;

    // Stopper toute synthèse en cours et couper l'audio en file
    if (interrupt) {
      try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
      premiumTtsAbort = new AbortController();
      outboundQueue = [];
      outboundQueuedBytes = 0;
    } else if (!premiumTtsAbort) {
      premiumTtsAbort = new AbortController();
    }
    premiumTtsInFlight = true;
    premiumTtsLastError = null;

    try {
      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selectedVoiceId)}/stream` +
        `?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}` +
        `&optimize_streaming_latency=${encodeURIComponent(String(ELEVENLABS_OPTIMIZE_STREAMING_LATENCY))}`;
      const resp = await fetch(url, {
        method: "POST",
        signal: premiumTtsAbort.signal,
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
          "Accept": "application/octet-stream",
        },
        body: JSON.stringify({
          text: clean,
          model_id: ELEVENLABS_MODEL_ID,
          voice_settings: {
            stability: Math.max(0, Math.min(1, ELEVENLABS_STABILITY)),
            similarity_boost: Math.max(0, Math.min(1, ELEVENLABS_SIMILARITY_BOOST)),
            style: Math.max(0, Math.min(1, ELEVENLABS_STYLE)),
            use_speaker_boost: ELEVENLABS_USE_SPEAKER_BOOST,
          },
        }),
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => "");
        premiumTtsLastError = { status: resp.status, body: errText.slice(0, 500), timestamp: new Date().toISOString() };
        console.error("❌ ElevenLabs TTS error:", premiumTtsLastError);
        // Fallback: laisser passer l'audio OpenAI pendant 5 minutes (sinon silence total)
        premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000;
        console.warn("↩️ FALLBACK ACTIVÉ: ElevenLabs en erreur → utilisation audio OpenAI pendant 5 min.");
        console.warn("   Pour désactiver le fallback, redémarre le serveur ou attends 5 min.");
        console.warn("   Vérifie ELEVENLABS_API_KEY, crédits ElevenLabs, et voice ID.");
        return;
      }

      // Formats ElevenLabs possibles:
      // - pcm_16000 (par défaut): PCM16 LE @ 16kHz → conversion vers μ-law 8kHz
      // - ulaw_8000: μ-law @ 8kHz → on peut envoyer directement à Twilio (meilleure stabilité + moins de CPU)
      const nodeStream = Readable.fromWeb(resp.body);
      let pcmBuf = Buffer.alloc(0);
      const maxBacklogSeconds = Number(process.env.ELEVENLABS_MAX_BACKLOG_SECONDS ?? "3");
      const maxBacklogBytes = Math.max(160 * 50, Math.floor(8000 * maxBacklogSeconds)); // 8k bytes/sec (μ-law 8kHz)

      const outFmt = String(ELEVENLABS_OUTPUT_FORMAT || "").toLowerCase();
      const isUlaw8k = outFmt.includes("ulaw_8000") || outFmt.includes("mulaw_8000") || outFmt.includes("g711_ulaw");

      for await (const chunk of nodeStream) {
        if (!chunk || chunk.length === 0) continue;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pcmBuf = Buffer.concat([pcmBuf, buf]);
        if (isUlaw8k) {
          // 20ms @ 8kHz μ-law = 160 bytes
          while (pcmBuf.length >= 160) {
            const frame = pcmBuf.subarray(0, 160);
            pcmBuf = pcmBuf.subarray(160);
            enqueueOutboundMulaw(frame);
            while (outboundQueuedBytes > maxBacklogBytes) {
              await sleep(20);
            }
          }
        } else {
          // pcm_16000: 20ms @ 16kHz PCM16 = 320 samples = 640 bytes
          while (pcmBuf.length >= 640) {
            const block = pcmBuf.subarray(0, 640);
            pcmBuf = pcmBuf.subarray(640);
            const mulawFrame = convertPcm16kBlockToMulaw(block); // 160 bytes
            enqueueOutboundMulaw(mulawFrame);
            while (outboundQueuedBytes > maxBacklogBytes) {
              await sleep(20);
            }
          }
        }
      }
      // Drop remainder (<20ms) to keep pacing stable.
      console.log("🎙️ ElevenLabs TTS terminé.", { chars: clean.length });
      // Si ElevenLabs fonctionne, on réinitialise le fallback (au cas où il était actif)
      if (premiumTtsBypassUntilMs > 0) {
        console.log("✅ ElevenLabs fonctionne → réinitialisation du fallback");
        premiumTtsBypassUntilMs = 0;
        premiumTtsLastError = null;
      }
    } catch (err) {
      if (String(err?.name) === "AbortError") return;
      console.error("❌ Erreur ElevenLabs TTS:", err);
      premiumTtsLastError = { message: String(err?.message ?? err), timestamp: new Date().toISOString() };
      premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000;
      console.warn("↩️ FALLBACK ACTIVÉ: Exception ElevenLabs → utilisation audio OpenAI pendant 5 min.");
      console.warn("   Pour désactiver le fallback, redémarre le serveur ou attends 5 min.");
      console.warn("   Vérifie ELEVENLABS_API_KEY, crédits ElevenLabs, et voice ID.");
    } finally {
      premiumTtsInFlight = false;
    }
  }

  function enqueuePremiumTts(text, { interrupt = true, source = "unknown", responseId = null, allowWithoutUser = false } = {}) {
    // LOG TRÈS VISIBLE au tout début pour tracer chaque appel (avec et sans emojis pour compatibilité)
    const rawText = String(text || "").substring(0, 200);
    if (LOG_TTS) {
      console.log(`[TTS-ENQUEUE] ENTRÉE [source: ${source}] [interrupt=${interrupt}] [queueLen=${premiumTtsQueue.length}] [inFlight=${premiumTtsInFlight}]`);
      console.log(`[TTS-ENQUEUE] TEXTE:`, rawText);
      console.log(`🚨🚨🚨 enqueuePremiumTts ENTRÉE [source: ${source}]:`, rawText);
      console.log(`🚨🚨🚨 enqueuePremiumTts ENTRÉE (interrupt=${interrupt}, queueLen=${premiumTtsQueue.length}, inFlight=${premiumTtsInFlight})`);
    }
    
    if (!PREMIUM_TTS_ENABLED) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] SORTIE: PREMIUM_TTS_ENABLED=false`);
        console.log(`🚨 enqueuePremiumTts SORTIE: PREMIUM_TTS_ENABLED=false`);
      }
      return;
    }
    const normalized = normalizeFrenchTtsText((text || "").trim());
    if (!normalized) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] SORTIE: texte vide après normalisation`);
        console.log(`🚨 enqueuePremiumTts SORTIE: texte vide après normalisation`);
      }
      return;
    }
    const clean = clipTtsText(normalized, MAX_TTS_CHARS);
    if (clean.length < normalized.length) {
      if (LOG_TTS) console.log(`[TTS-ENQUEUE] TEXTE TRONQUÉ: ${normalized.length} -> ${clean.length} chars`);
    }
    // Log explicite du texte qui va être prononcé (l'utilisateur pourra le copier facilement)
    console.log(`[AI-SAYS] ${clean}`);
    const lowerClean = clean.toLowerCase().trim();
    if (
      lowerClean === "output" ||
      lowerClean === "outpout" ||
      lowerClean.startsWith("output ") ||
      lowerClean.includes("output item") ||
      lowerClean.includes("output_item") ||
      lowerClean.includes("output text") ||
      lowerClean.includes("output_text") ||
      lowerClean.includes("messaging")
    ) {
      if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: texte suspect (logs)`, clean.substring(0, 120));
      return;
    }

    // Normalisation agressive pour la comparaison (ignore ponctuation et casse)
    const normalizedForCompare = clean.toLowerCase().replace(/[.,!?;:]/g, "").trim();
    const now = nowMs();

    // Garder la parole uniquement si une prise de parole utilisateur est récente
    if (!allowWithoutUser) {
      const hasRecentUserSpeech = lastCommittedAt > 0 && (now - lastCommittedAt) <= ASSISTANT_RESPONSE_WINDOW_MS;
      if (!hasRecentUserSpeech) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: pas de parole utilisateur récente (lastCommittedAt=${lastCommittedAt})`);
        return;
      }
      // Une seule réponse TTS par commit utilisateur (évite les répétitions multi-events)
      if (lastSpokenCommitAt && lastCommittedAt && lastSpokenCommitAt === lastCommittedAt) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: déjà parlé pour ce commit`, { lastCommittedAt });
        return;
      }
    }

    // Anti-répétition par responseId
    if (responseId) {
      const prev = spokenResponseIds.get(responseId);
      if (prev) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: responseId déjà parlé`, { responseId });
        return;
      }
    }

    // Anti-répétition par texte sur fenêtre courte (même si responseId change)
    recentAssistantTexts = recentAssistantTexts.filter((t) => (now - t.ts) < 60_000);
    if (recentAssistantTexts.some((t) => t.text === normalizedForCompare)) {
      if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: texte déjà prononcé récemment`, clean.substring(0, 120));
      return;
    }

    // Éviter de rejouer en boucle exactement la même phrase (ex: greeting)
    // On vérifie aussi dans la queue pour éviter les doublons même si les événements arrivent en même temps
    // Fonction pour calculer la similarité entre deux textes (basée sur les mots communs)
    const calculateSimilarity = (text1, text2) => {
      const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words1.length === 0 || words2.length === 0) return 0;
      const commonWords = words1.filter(w => words2.includes(w));
      return commonWords.length / Math.max(words1.length, words2.length);
    };
    
    if (premiumTtsLastText) {
      const lastNormalized = normalizeFrenchTtsText(premiumTtsLastText).toLowerCase().replace(/[.,!?;:]/g, "").trim();
      // Vérifier l'égalité exacte
      if (lastNormalized === normalizedForCompare) {
        if (LOG_TTS) {
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (identique au précédent) [source: ${source}]:`, clean.substring(0, 120));
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (lastText):`, premiumTtsLastText.substring(0, 120));
          console.log(`🚨🚨🚨 REPETITION BLOQUÉE (texte identique au précédent) [source: ${source}]:`, clean.substring(0, 120));
          console.log(`🚨🚨🚨 REPETITION BLOQUÉE (lastText):`, premiumTtsLastText.substring(0, 120));
        }
        return;
      }
      // Vérifier la similarité (si > 80% de mots communs, considérer comme répétition)
      const similarity = calculateSimilarity(lastNormalized, normalizedForCompare);
      if (similarity > 0.8 && normalizedForCompare.length > 20) {
        if (LOG_TTS) {
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (similaire à ${Math.round(similarity * 100)}%) [source: ${source}]:`, clean.substring(0, 120));
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (lastText):`, premiumTtsLastText.substring(0, 120));
        }
        return;
      }
    }
    // Vérifier aussi dans la queue actuelle
    if (premiumTtsQueue.some(job => {
      const jobNormalized = normalizeFrenchTtsText(job.text.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim();
      if (jobNormalized === normalizedForCompare) return true;
      // Vérifier la similarité
      const similarity = calculateSimilarity(jobNormalized, normalizedForCompare);
      return similarity > 0.8 && normalizedForCompare.length > 20;
    })) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (déjà dans la queue) [source: ${source}]:`, clean.substring(0, 120));
        console.log(`🚨🚨🚨 REPETITION BLOQUÉE (déjà dans la queue) [source: ${source}]:`, clean.substring(0, 120));
      }
      return;
    }

    // Si le client parle, on retarde la réponse (sinon ça parle par-dessus).
    if (OUTPUT_WAIT_FOR_USER_SILENCE && outUserSpeaking) {
      if (interrupt) pendingSpeakQueue = [];
      pendingSpeakQueue.push(clean);
      return;
    }

    // Si interrupt: on coupe net et on repart avec la nouvelle phrase
    // MAIS SEULEMENT si aucune synthèse n'est déjà en cours pour éviter les coupures
    if (interrupt && !premiumTtsInFlight) {
      premiumTtsQueue = [];
      try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
      premiumTtsAbort = new AbortController();
      outboundQueue = [];
      outboundQueuedBytes = 0;
    } else if (!premiumTtsAbort) {
      premiumTtsAbort = new AbortController();
    }

    premiumTtsQueue.push({ text: clean, interrupt });
    premiumTtsLastText = clean;
    lastAssistantSpokenAt = now;
    lastAssistantSpokenResponseId = responseId ?? lastAssistantSpokenResponseId;
    if (responseId) {
      spokenResponseIds.set(responseId, now);
      if (spokenResponseIds.size > 500) {
        for (const [rid, ts] of spokenResponseIds) {
          if ((now - ts) > 300_000) spokenResponseIds.delete(rid);
        }
      }
    }
    if (!allowWithoutUser && lastCommittedAt) {
      lastSpokenCommitAt = lastCommittedAt;
    }
    recentAssistantTexts.push({ text: normalizedForCompare, ts: now });
    if (LOG_TTS) {
      console.log(`[TTS-ENQUEUE] ENQUEUED (ajouté à la queue) [source: ${source}] [queueLen=${premiumTtsQueue.length}] [interrupt=${interrupt}]`);
      console.log(`[TTS-ENQUEUE] TEXTE ENQUEUED:`, clean.substring(0, 200));
      console.log(`🚨🚨🚨 TTS ENQUEUED (ajouté à la queue) [source: ${source}]:`, clean.substring(0, 200));
      console.log(`🚨🚨🚨 TTS ENQUEUED (queueLen=${premiumTtsQueue.length}, interrupt=${interrupt})`);
    }
    void drainPremiumTtsQueue();
  }

  // Alias pour compatibilité
  function enqueueElevenLabsTts(text, { interrupt = true } = {}) {
    enqueuePremiumTts(text, { interrupt, source: "legacy_elevenlabs" });
  }

  async function drainPremiumTtsQueue() {
    if (premiumTtsDrainInFlight) return;
    premiumTtsDrainInFlight = true;
    try {
      let lastProcessedText = "";
      while (premiumTtsQueue.length > 0) {
        const job = premiumTtsQueue.shift();
        if (!job) continue;
        // Vérifier si ce texte est identique au précédent (normalisé)
        const jobNormalized = normalizeFrenchTtsText(job.text.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim();
        const lastNormalized = lastProcessedText ? normalizeFrenchTtsText(lastProcessedText.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim() : "";
        if (lastNormalized && jobNormalized === lastNormalized) {
          if (LOG_TTS) {
            console.log(`[TTS-DRAIN] IGNORÉ (doublon dans la queue):`, job.text.substring(0, 120));
            console.log(`🔁 drainPremiumTtsQueue ignoré (doublon dans la queue):`, job.text.substring(0, 120));
          }
          continue;
        }
        lastProcessedText = job.text;
        // Interrupt a déjà été géré à l'enqueue: ici on ne re-clear pas l'audio.
        if (PREMIUM_TTS_PROVIDER === "minimax") {
          await speakWithMinimaxNow(job.text, { interrupt: false });
        } else if (PREMIUM_TTS_PROVIDER === "elevenlabs") {
          await speakWithElevenLabsNow(job.text, { interrupt: false });
        }
      }
    } finally {
      premiumTtsDrainInFlight = false;
    }
  }

  // Alias pour compatibilité
  async function drainElevenLabsQueue() {
    await drainPremiumTtsQueue();
  }

  // Énergie moyenne sur une frame μ-law (utile pour détecter silence/parole)
  function avgAbsMulaw(mulawBuf) {
    if (!mulawBuf || mulawBuf.length === 0) return false;
    let sum = 0;
    for (let i = 0; i < mulawBuf.length; i++) {
      const s = MULAW_DECODE_TABLE[mulawBuf[i] & 0xff];
      sum += Math.abs(s);
    }
    return sum / mulawBuf.length;
  }

  function numberToFrenchWords(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n);
    if (num < 0 || num > 9999) return String(n);
    const units = [
      "zéro",
      "un",
      "deux",
      "trois",
      "quatre",
      "cinq",
      "six",
      "sept",
      "huit",
      "neuf",
      "dix",
      "onze",
      "douze",
      "treize",
      "quatorze",
      "quinze",
      "seize",
      "dix-sept",
      "dix-huit",
      "dix-neuf",
    ];
    const tensMap = {
      20: "vingt",
      30: "trente",
      40: "quarante",
      50: "cinquante",
      60: "soixante",
    };
    const twoDigits = (n2) => {
      if (n2 < 20) return units[n2];
      if (n2 < 70) {
        const tens = Math.floor(n2 / 10) * 10;
        const unit = n2 % 10;
        if (unit === 0) return tensMap[tens];
        if (unit === 1) return `${tensMap[tens]} et un`;
        return `${tensMap[tens]}-${units[unit]}`;
      }
      if (n2 < 80) {
        const rest = n2 - 60;
        if (rest === 11) return "soixante et onze";
        return `soixante-${units[rest]}`;
      }
      if (n2 < 100) {
        const rest = n2 - 80;
        if (rest === 0) return "quatre-vingt";
        return `quatre-vingt-${units[rest]}`;
      }
      return String(n2);
    };

    const threeDigits = (n3) => {
      if (n3 < 100) return twoDigits(n3);
      const hundreds = Math.floor(n3 / 100);
      const rest = n3 % 100;
      const hundredWord = hundreds === 1 ? "cent" : `${units[hundreds]} cent`;
      if (rest === 0) return hundreds > 1 ? `${hundredWord}s` : hundredWord;
      return `${hundredWord} ${twoDigits(rest)}`;
    };

    if (num < 100) return twoDigits(num);
    if (num < 1000) return threeDigits(num);
    const thousands = Math.floor(num / 1000);
    const rest = num % 1000;
    const thousandWord = thousands === 1 ? "mille" : `${threeDigits(thousands)} mille`;
    if (rest === 0) return thousandWord;
    return `${thousandWord} ${threeDigits(rest)}`;
  }

  // Variante "TTS-friendly": évite les tirets dans les nombres (certains TTS FR prononcent mal les mots hyphenés)
  function numberToFrenchWordsTts(n) {
    return numberToFrenchWords(n).replace(/-/g, " ").replace(/\s+/g, " ").trim();
  }

  // Pré-traitement TTS (améliore articulation/intonation en téléphonie)
  // IMPORTANT: Ce dictionnaire doit être appliqué de manière cohérente pour éviter les variations de prononciation
  // entre la phrase d'accueil et le reste de la conversation
  function normalizeFrenchTtsText(input) {
    let t = String(input || "").trim();
    if (!t) return "";
    // Nettoyage léger
    t = t.replace(/\s+/g, " ");
    // IMPORTANT: Convertir les heures AVANT de coller les chiffres séparés
    // Heures au format "8h30" / "8 h 30" / "8:30" / "8H30" -> "huit heures trente"
    // Gérer aussi le cas où les minutes sont séparées : "8 h 3 0" -> "huit heures trente"
    
    // Format avec minutes séparées AVANT "heures" (ex: "8 h 3 0" ou "8 h 3  0")
    // IMPORTANT: Traiter AVANT le format "heures" pour éviter les conflits
    t = t.replace(/(\d{1,2})\s*[hH:]\s*(\d)\s+(\d)\b/g, (_, h, m1, m2) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m1 + m2);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord}${minutesWord}`.trim();
    });
    // Format standard avec minutes collées AVANT "heures" (ex: "8h30" / "8 h 30" / "8:30")
    t = t.replace(/(\d{1,2})\s*[hH:]\s*(\d{2})\b/g, (_, h, m) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord}${minutesWord}`.trim();
    });
    
    // Format "X heures Y Z" ou "X heure Y Z" avec minutes séparées (ex: "8 heures 3 0" -> "huit heures trente")
    // IMPORTANT: Placer cette regex AVANT celle avec (\d{2}) pour qu'elle matche en premier
    t = t.replace(/\b(\d{1,2})\s+heures?\s+(\d)\s+(\d)\b/gi, (_, h, m1, m2) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m1 + m2);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord}${minutesWord}`.trim();
    });
    // Format "X heures YY" ou "X heure YY" avec minutes collées (ex: "8 heures 30" -> "huit heures trente")
    // Gérer aussi les cas sans espaces : "8heures30" ou "8 heures30" ou "8heures 30"
    t = t.replace(/\b(\d{1,2})\s*heures?\s*(\d{2})\b/gi, (_, h, m) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord}${minutesWord}`.trim();
    });
    
    // Fallback: Si les heures sont déjà en mots français (huit, neuf, etc.) et les minutes sont en chiffres
    // Ex: "huit heures 30" ou "huitheures30" -> "huit heures trente"
    // Gérer aussi les cas sans espaces
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s*heures?\s*(\d{2})\b/gi, (_, hoursWord, m) => {
      const minutesNum = Number(m);
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord} heures${minutesWord}`.trim();
    });
    // Fallback: Si les heures sont déjà en mots français (huit, neuf, etc.) et les minutes sont séparées
    // Ex: "huit heures 3 0" ou "huit heure 3 0" -> "huit heures trente"
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(\d)\s+(\d)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesNum = Number(m1 + m2);
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${hoursWord} heures${minutesWord}`.trim();
    });
    // Format "8h" sans minutes
    t = t.replace(/\b(\d{1,2})\s*[hH]\b/gi, (_, h) => {
      const hoursNum = Number(h);
      return hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
    });
    // IMPORTANT: Traiter les montants AVANT de coller les chiffres séparés
    // Montants avec chiffres séparés (ex: "1 2 euros" -> "douze euros")
    t = t.replace(/\b(\d(?:\s+\d){1,4})\s*(?:€|euros?)\b/gi, (_, n) => {
      const compact = String(n).replace(/\s+/g, "");
      return `${numberToFrenchWordsTts(compact)} euros`;
    });
    // Décimales en euros avec chiffres séparés (ex: "1 2,50 euros")
    t = t.replace(/\b(\d(?:\s+\d){1,4})[.,](\d{1,2})\s*(?:€|euros?)\b/gi, (_, n, d) => {
      const major = numberToFrenchWordsTts(String(n).replace(/\s+/g, ""));
      const minor = numberToFrenchWordsTts(d);
      return `${major} euros ${minor}`;
    });
    // Normalisation des montants en euros (1-9999) pour éviter "1 et 2"
    t = t.replace(/\b(\d{1,4})\s*(?:€|euros?)\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} euros`);
    // Décimales en euros (ex: 12,50€ / 12.50 euros)
    t = t.replace(/\b(\d{1,4})[.,](\d{1,2})\s*(?:€|euros?)\b/gi, (_, n, d) => {
      const major = numberToFrenchWordsTts(n);
      const minor = numberToFrenchWordsTts(d);
      return `${major} euros ${minor}`;
    });
    // Coller les chiffres séparés (ex: "1 2" -> "12") pour éviter la lecture "un deux"
    // (sans toucher aux longues séquences type numéros de téléphone)
    // MAIS après avoir traité les heures et les montants pour éviter de casser "8h30" et "12 euros"
    t = t.replace(/\b(\d(?:\s+\d){1,5})\b/g, (m) => {
      // Ne pas toucher si c'est déjà une heure (contient "heure" après) ou un montant (contient "euros" après)
      if (/heure|euros?/.test(m)) return m;
      return m.replace(/\s+/g, "");
    });
    // Abbréviations courantes
    t = t.replace(/\bRDV\b/gi, "rendez-vous");
    t = t.replace(/\bOK\b/g, "ok");
    // Dire "message" à la place de "SMS" en gardant une grammaire naturelle
    t = t.replace(/\ble\s+SMS\b/gi, "le message");
    t = t.replace(/\bun\s+SMS\b/gi, "un message");
    t = t.replace(/\bdes\s+SMS\b/gi, "des messages");
    t = t.replace(/\bpar\s+SMS\b/gi, "par message");
    t = t.replace(/\bvia\s+SMS\b/gi, "par message");
    t = t.replace(/\ben\s+SMS\b/gi, "par message");
    t = t.replace(/\bl['’]SMS\b/gi, "le message");
    t = t.replace(/\bSMS\b/gi, "un message");
    // Sigles auto (prononcer lettre par lettre)
    t = t.replace(/\bFAP\b/gi, "F A P");
    t = t.replace(/\bABS\b/gi, "A B S");
    t = t.replace(/\bESP\b/gi, "E S P");
    t = t.replace(/\bEGR\b/gi, "E G R");
    t = t.replace(/\bOBD\b/gi, "O B D");
    t = t.replace(/\bTDI\b/gi, "T D I");
    t = t.replace(/\bHDI\b/gi, "H D I");
    t = t.replace(/\bTSI\b/gi, "T S I");
    t = t.replace(/\bGPL\b/gi, "G P L");
    t = t.replace(/\bSUV\b/gi, "S U V");
    t = t.replace(/\bBVA\b/gi, "B V A");
    t = t.replace(/\bBVM\b/gi, "B V M");
    t = t.replace(/\bCT\b/gi, "contrôle technique");
    t = t.replace(/\bTVA\b/gi, "T V A");
    t = t.replace(/\bTTC\b/gi, "T T C");
    t = t.replace(/\bHT\b/gi, "H T");
    t = t.replace(/\bABS\b/gi, "A B S");
    t = t.replace(/\bESP\b/gi, "E S P");
    t = t.replace(/\bEGR\b/gi, "E G R");
    t = t.replace(/\bFAP\b/gi, "F A P");
    t = t.replace(/\bDPF\b/gi, "D P F");
    t = t.replace(/\bOBD\b/gi, "O B D");
    t = t.replace(/\bVIN\b/gi, "V I N");
    t = t.replace(/\bSUV\b/gi, "S U V");
    t = t.replace(/\bHDI\b/gi, "H D I");
    t = t.replace(/\bTSI\b/gi, "T S I");
    t = t.replace(/\bTDI\b/gi, "T D I");
    t = t.replace(/\bSAV\b/gi, "S A V");
    t = t.replace(/\bAdBlue\b/gi, "Ad Blu");
    
    // Prononciations FR (téléphonie): dictionnaire complet pour cohérence
    // Marques automobiles (prononciation française standardisée)
    t = t.replace(/\bSEAT\b/gi, "Siat");
    t = t.replace(/\bPeugeot\b/gi, "Peujo");
    t = t.replace(/\bRenault\b/gi, "Renô");
    t = t.replace(/\bCitro[eë]n\b/gi, "Citroën");
    t = t.replace(/\bVolkswagen\b/gi, "Volksvaguen");
    t = t.replace(/\bMercedes\b/gi, "Mèr-cè-dès");
    t = t.replace(/\bNorauto\b/gi, "Norauto");
    t = t.replace(/\bBMW\b/gi, "Bé M Double Vé");
    t = t.replace(/\bAudi\b/gi, "Aoudi");
    t = t.replace(/\bOpel\b/gi, "Opèl");
    t = t.replace(/\bFord\b/gi, "Forde");
    t = t.replace(/\bToyota\b/gi, "Toyota");
    t = t.replace(/\bNissan\b/gi, "Nissane");
    t = t.replace(/\bHyundai\b/gi, "Hyoundaï");
    t = t.replace(/\bKia\b/gi, "Kia");
    t = t.replace(/\bDacia\b/gi, "Datchia");
    t = t.replace(/\bFiat\b/gi, "Fiate");
    t = t.replace(/\bVolvo\b/gi, "Volvo");
    t = t.replace(/\bSkoda\b/gi, "Skoda");
    t = t.replace(/\bMazda\b/gi, "Mazda");
    t = t.replace(/\bSuzuki\b/gi, "Suzuki");
    t = t.replace(/\bHonda\b/gi, "Honda");
    t = t.replace(/\bMitsubishi\b/gi, "Mitsubishi");
    t = t.replace(/\bSubaru\b/gi, "Subaru");
    t = t.replace(/\bLexus\b/gi, "Lexus");
    t = t.replace(/\bInfiniti\b/gi, "Infiniti");
    t = t.replace(/\bJaguar\b/gi, "Jaguar");
    t = t.replace(/\bLand Rover\b/gi, "Land Rover");
    t = t.replace(/\bRange Rover\b/gi, "Range Rover");
    t = t.replace(/\bPorsche\b/gi, "Porsche");
    t = t.replace(/\bFerrari\b/gi, "Ferrari");
    t = t.replace(/\bLamborghini\b/gi, "Lamborghini");
    t = t.replace(/\bBentley\b/gi, "Bentley");
    t = t.replace(/\bRolls-Royce\b/gi, "Rolls-Royce");
    t = t.replace(/\bTesla\b/gi, "Tesla");
    t = t.replace(/\bBYD\b/gi, "Bé Y Dé");
    t = t.replace(/\bMG\b/gi, "M G");
    
    // Mots courants du garage (normalisation pour cohérence)
    // Ces mots sont souvent mal prononcés différemment selon le contexte
    // Expressions fréquentes de liaison / questions
    // On aide le TTS à mieux articuler certains groupes de mots
    t = t.replace(/\best-ce que\b/gi, "est ce que");
    t = t.replace(/\best ce que\b/gi, "est ce que");
    t = t.replace(/\brécupérer\b/gi, "récupérer");
    t = t.replace(/\bimmatriculation\b/gi, "immatriculation");
    t = t.replace(/\bplaque\b/gi, "plaque");
    t = t.replace(/\bvidange\b/gi, "vidange");
    t = t.replace(/\brévision\b/gi, "révision");
    t = t.replace(/\bdiagnostic\b/gi, "diagnostic");
    t = t.replace(/\bfreinage\b/gi, "freinage");
    t = t.replace(/\bplaquettes\b/gi, "plaquettes");
    t = t.replace(/\bdisques\b/gi, "disques");
    t = t.replace(/\bembrayage\b/gi, "embrayage");
    t = t.replace(/\bcourroie\b/gi, "courroie");
    t = t.replace(/\bdistribution\b/gi, "distribution");
    t = t.replace(/\bclimatisation\b/gi, "climatisation");
    t = t.replace(/\bvéhicule\b/gi, "véhicule");
    t = t.replace(/\bvoiture\b/gi, "voiture");
    t = t.replace(/\bgarage\b/gi, "garage");
    t = t.replace(/\bassistante\b/gi, "assistante");
    t = t.replace(/\bassistant\b/gi, "assistant");
    t = t.replace(/\bdisponibilité\b/gi, "disponibilité");
    t = t.replace(/\bdisponibilités\b/gi, "disponibilités");
    t = t.replace(/\bappareil\b/gi, "appareil");
    t = t.replace(/\bamène\b/gi, "amène");
    t = t.replace(/\bconvenir\b/gi, "convenir");
    t = t.replace(/\bconvenu\b/gi, "convenu");
    t = t.replace(/\bconvenez\b/gi, "convenez");
    t = t.replace(/\bkilométrage\b/gi, "kilométrage");
    t = t.replace(/\bkilomètres\b/gi, "kilomètres");
    t = t.replace(/\bkilomètre\b/gi, "kilomètre");
    t = t.replace(/\bapproximatif\b/gi, "approximatif");
    t = t.replace(/\bapproximative\b/gi, "approximative");
    t = t.replace(/\bconseiller\b/gi, "conseiller");
    t = t.replace(/\bconseillère\b/gi, "conseillère");
    t = t.replace(/\bproblème\b/gi, "problème");
    t = t.replace(/\bproblèmes\b/gi, "problèmes");
    t = t.replace(/\bvoyant\b/gi, "voyant");
    t = t.replace(/\bvoyants\b/gi, "voyants");
    t = t.replace(/\bdémarrage\b/gi, "démarrage");
    t = t.replace(/\barrêt\b/gi, "arrêt");
    t = t.replace(/\barrêter\b/gi, "arrêter");
    t = t.replace(/\barrêté\b/gi, "arrêté");
    t = t.replace(/\bdisponibilité\b/gi, "disponibilité");
    t = t.replace(/\bdisponibilités\b/gi, "disponibilités");
    t = t.replace(/\bconfirmer\b/gi, "confirmer");
    t = t.replace(/\bconfirmation\b/gi, "confirmation");
    t = t.replace(/\bconfirme\b/gi, "confirme");
    t = t.replace(/\bconfirmé\b/gi, "confirmé");
    t = t.replace(/\bconfirmez\b/gi, "confirmez");
    t = t.replace(/\bcompris\b/gi, "compris");
    t = t.replace(/\bcomprendre\b/gi, "comprendre");
    t = t.replace(/\bcomprends\b/gi, "comprends");
    t = t.replace(/\bcomprenez\b/gi, "comprenez");
    t = t.replace(/\brépéter\b/gi, "répéter");
    t = t.replace(/\brépète\b/gi, "répète");
    t = t.replace(/\brépétez\b/gi, "répétez");
    t = t.replace(/\breformuler\b/gi, "reformuler");
    t = t.replace(/\breformule\b/gi, "reformule");
    t = t.replace(/\breformulez\b/gi, "reformulez");
    t = t.replace(/\bpardon\b/gi, "pardon");
    t = t.replace(/\bexcusez\b/gi, "excusez");
    t = t.replace(/\bexcuse\b/gi, "excuse");
    t = t.replace(/\bexcuses\b/gi, "excuses");

    
    // (Montants déjà traités plus haut, avant le collage des chiffres séparés)
    // Kilomètres / minutes
    t = t.replace(/\b(\d{1,4})\s*km\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} kilomètres`);
    t = t.replace(/\b(\d{1,4})\s*minutes?\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} minutes`);
    t = t.replace(/\b(\d{1,4})\s*min\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} minutes`);
    // (Heures gérées plus haut: "8h30" / "8:30" -> "huit heures trente")
    // IMPORTANT: Convertir les minutes après "heures" ou "heure" AVANT de convertir tous les nombres
    // Fallback final pour "heures" ou "heure" suivis de chiffres (en cas d'échec des regex précédentes)
    // Gérer aussi les cas sans espaces : "heures30" ou "heure30"
    t = t.replace(/\b(heures?|heure)\s*(\d{1,2})\s+(\d)\b/gi, (_, heuresWord, m1, m2) => {
      const minutesNum = Number(m1 + m2);
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${heuresWord}${minutesWord}`.trim();
    });
    t = t.replace(/\b(heures?|heure)\s*(\d{2})\b/gi, (_, heuresWord, m) => {
      const minutesNum = Number(m);
      const minutesWord = minutesNum === 0 ? "" : ` ${numberToFrenchWordsTts(minutesNum)}`;
      return `${heuresWord}${minutesWord}`.trim();
    });
    // Tous les nombres restants → en lettres (ou par chiffres séparés si trop grand)
    // IMPORTANT: Ne pas convertir les nombres qui sont déjà après "heures" ou "heure"
    t = t.replace(/\b(\d{1,6})\b/g, (match, n, offset, string) => {
      // Vérifier si ce nombre suit "heures" ou "heure" (ne pas convertir dans ce cas)
      const before = string.substring(Math.max(0, offset - 20), offset);
      if (/\b(heures?|heure)\s+$/i.test(before)) {
        return match; // Garder le nombre tel quel, il sera traité par les regex ci-dessus
      }
      return numberToFrenchWordsTts(n);
    });
    // Normalisation des nombres pour cohérence (fallback)
    t = t.replace(/\b(\d+)\s*€\b/gi, "$1 euros");
    t = t.replace(/\b(\d+)\s*euros?\b/gi, "$1 euros");
    t = t.replace(/\b(\d+)\s*km\b/gi, "$1 kilomètres");
    t = t.replace(/\b(\d+)\s*kilomètres?\b/gi, "$1 kilomètres");
    t = t.replace(/\bparallélisme\b/gi, "parallélisme");
    t = t.replace(/\bgéométrie\b/gi, "géométrie");
    t = t.replace(/\bcontrôle\b/gi, "contrôle");
    t = t.replace(/\btechnique\b/gi, "technique");
    t = t.replace(/\bbatterie\b/gi, "batterie");
    t = t.replace(/\bpneus\b/gi, "pneus");
    t = t.replace(/\béquilibrage\b/gi, "équilibrage");

    // Corrections orthographiques fréquentes (évite prononciations incompréhensibles)
    t = t.replace(/\bcinquente\b/gi, "cinquante");
    
    // Ponctuation FR (aide l'intonation)
    t = t.replace(/\s*([!?;:])\s*/g, "$1 ");
    t = t.replace(/\s*([,.])\s*/g, "$1 ");
    // Aide prononciation Minimax sur certains nombres (ex: "cinquante" parfois mal articulé)
    t = t.replace(/\bcinquante\b/gi, "cinq ante");
    // Pauses naturelles
    t = t.replace(/(\d)\s*km\b/gi, "$1 kilomètres");
    // Eviter les très longues phrases (téléphonie)
    if (t.length > 220 && !/[.!?]/.test(t.slice(-20))) t += ".";
    return t.trim();
  }

  function clipTtsText(input, maxChars) {
    const t = String(input || "").trim();
    if (!t) return "";
    if (!maxChars || t.length <= maxChars) return t;
    const slice = t.slice(0, maxChars);
    const lastPunct = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("… "),
    );
    if (lastPunct > 40) {
      return slice.slice(0, lastPunct + 1).trim();
    }
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 40) return slice.slice(0, lastSpace).trim() + "…";
    return slice.trim() + "…";
  }

  // Détection parole côté Twilio (pour barge-in) : plus stable que les events VAD OpenAI en environnement bruyant.
  // DÉSACTIVÉ par défaut car trop sensible (bruit de fond, TV, etc. déclenchent des coupures intempestives)
  // Pour activer: mettre BARGE_IN_ENABLED=true dans Render avec des seuils élevés (BARGE_IN_THRESHOLD=15000, BARGE_IN_FRAMES=35)
  const BARGE_IN_ENABLED = (process.env.BARGE_IN_ENABLED ?? "false").toLowerCase() === "true";
  const TWILIO_SPEECH_THRESHOLD = Number(process.env.BARGE_IN_THRESHOLD ?? "15000"); // Seuil élevé pour éviter les faux positifs
  const BARGE_IN_FRAMES = Number(process.env.BARGE_IN_FRAMES ?? "35"); // ~700ms de parole continue nécessaire
  let twilioSpeechFrames = 0;

  // Noise gate / VAD local pour l'INPUT (évite que la TV/bruit déclenche des réponses automatiques).
  // IMPORTANT: en pratique, trop agressif peut faire "l'IA ne répond pas".
  // Donc par défaut on l'active seulement si la variable Render est explicitement à true.
  // En realtime, on active le gate par défaut pour éviter que l'IA réponde sur une micro-pause.
  const INPUT_GATE_ENABLED = (process.env.INPUT_GATE_ENABLED ?? (PIPELINE_MODE === "realtime" ? "true" : "false")).toLowerCase() === "true";
  // Valeurs plus strictes par défaut pour éviter les faux positifs (IA qui répond sans parole réelle)
  // Augmenté pour être moins sensible au bruit de fond
  const INPUT_SPEECH_THRESHOLD = Number(process.env.INPUT_SPEECH_THRESHOLD ?? "1200"); // Augmenté de 900 à 1200
  const INPUT_SPEECH_FRAMES = Number(process.env.INPUT_SPEECH_FRAMES ?? "10"); // Augmenté de 6 à 10 (~200ms au lieu de 120ms)
  const INPUT_SILENCE_THRESHOLD = Number(process.env.INPUT_SILENCE_THRESHOLD ?? "450");
  const INPUT_SILENCE_FRAMES = Number(process.env.INPUT_SILENCE_FRAMES ?? (PIPELINE_MODE === "realtime" ? "28" : "20")); // ~560ms en realtime
  let inputSpeechFrames = 0;
  let inputSilenceFrames = 0;
  let inputActive = false; // on est en train d'envoyer une "prise de parole" à OpenAI
  let bytesSinceInputStart = 0;
  let lastInputAudioLevel = 0; // Niveau audio moyen de la dernière frame pour filtrer les faux positifs OpenAI
  let lastInputCommitAt = 0;
  const LOCAL_COMMIT_ENABLED = (process.env.LOCAL_COMMIT_ENABLED ?? "false").toLowerCase() === "true";
  // Anti-écho: si l'IA parle, on peut ignorer l'audio entrant pour éviter que la TV/retour audio déclenche un nouveau tour.
  const INPUT_SUPPRESS_WHILE_TALKING = (process.env.INPUT_SUPPRESS_WHILE_TALKING ?? "true").toLowerCase() === "true";
  // Réduit à 2 frames (~40ms) pour ne bloquer que l'écho immédiat, pas la parole utilisateur
  const INPUT_SUPPRESS_BACKLOG_FRAMES = Number(process.env.INPUT_SUPPRESS_BACKLOG_FRAMES ?? "2"); // ~40ms d'audio sortant
  // Si le client parle fort/clair, on laisse passer même si l'assistant parle (améliore la compréhension, sans activer le barge-in).
  // Autoriser une voix "normale" à passer même si l'assistant parle (évite incompréhension si le client parle tôt).
  // Par défaut, on laisse passer une voix "normale" même si l'assistant parle (sinon incompréhension).
  // Trop haut => le client doit crier pour être entendu.
  const INPUT_SUPPRESS_OVERRIDE_THRESHOLD = Number(
    process.env.INPUT_SUPPRESS_OVERRIDE_THRESHOLD ?? String(Math.max(2500, Math.floor(INPUT_SPEECH_THRESHOLD * 1.5))),
  );

  // Realtime: voix
  // - openai: utiliser l'audio renvoyé par OpenAI Realtime
  // - elevenlabs: utiliser le transcript OpenAI Realtime et faire parler ElevenLabs
  const REALTIME_TTS_MODE = (process.env.REALTIME_TTS_MODE ?? "openai").toLowerCase();
  // REALTIME_USE_ELEVEN est maintenant utilisé pour tous les TTS premium (ElevenLabs ou Minimax)
  const REALTIME_USE_ELEVEN =
    PIPELINE_MODE === "realtime" &&
    PREMIUM_TTS_ENABLED &&
    (PREMIUM_TTS_PROVIDER === "elevenlabs" || PREMIUM_TTS_PROVIDER === "minimax");

  // Realtime+ElevenLabs: "direct" (chunking) pour parler dès que le texte arrive
  const REALTIME_ELEVEN_CHUNKING_ENABLED = (process.env.REALTIME_ELEVEN_CHUNKING_ENABLED ?? "true").toLowerCase() === "true";
  // Valeurs par défaut plus "stables" (moins de requêtes ElevenLabs ⇒ moins de coupures).
  // On baisse le seuil min par défaut pour améliorer la réactivité (quand OpenAI envoie des deltas).
  const REALTIME_ELEVEN_CHUNK_MIN_CHARS = Number(process.env.REALTIME_ELEVEN_CHUNK_MIN_CHARS ?? "40");
  const REALTIME_ELEVEN_CHUNK_MAX_CHARS = Number(process.env.REALTIME_ELEVEN_CHUNK_MAX_CHARS ?? "240");

  function requestResponseCreate(reason) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    // Ne pas spam: si OpenAI a déjà une réponse en cours, ou si on vient juste d'en demander une.
    const now = nowMs();
    if (responseInProgress) return;
    if ((now - lastResponseCreateRequestedAt) < RESPONSE_CREATE_DEBOUNCE_MS) return;
    lastResponseCreateRequestedAt = now;
    try {
      // IMPORTANT: `response.voice` n'est pas accepté (erreur: unknown_parameter) sur notre modèle Realtime actuel.
      // Donc on n'envoie PAS de paramètre voice ici.
      // L'API Realtime génère automatiquement l'audio si output_audio_format est dans l'URL WebSocket
      // Pas besoin de spécifier modalities dans response.create (ce paramètre n'existe pas)
      openaiWs.send(JSON.stringify({ type: "response.create" }));
      if (reason) console.log("🗣️ response.create envoyé:", { reason });
    } catch (err) {
      console.error("❌ Erreur response.create:", err);
    }
  }

  function cancelResponseForBargeIn() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!responseInProgress) return;
    try {
      openaiWs.send(JSON.stringify({ type: "response.cancel" }));
      responseInProgress = false;
      activeResponseId = null;
      // Couper immédiatement l'audio sortant (sinon l'appelant entend la fin du message pendant qu'il parle)
      outboundQueue = [];
      outboundQueuedBytes = 0;
      console.log("✋ Barge-in: response.cancel + purge outbound.");
    } catch (err) {
      console.error("❌ Erreur response.cancel:", err);
    }
  }

  function enqueueOutboundMulaw(buf) {
    if (!buf || buf.length === 0) return;
    // IMPORTANT: ne pas "drop" agressivement, sinon ça coupe les mots et ça devient inaudible.
    // On accepte du backlog (latence) et on ne drop qu'en cas extrême (sécurité mémoire).
    const SOFT_MAX_BACKLOG_BYTES = 160 * 500; // ~10s @ 20ms
    const HARD_MAX_BACKLOG_BYTES = 160 * 1500; // ~30s @ 20ms
    if (outboundQueuedBytes > HARD_MAX_BACKLOG_BYTES) {
      // Drop uniquement si on dépasse 30s, sinon on préfère garder l'intelligibilité.
      while (outboundQueue.length > 0 && outboundQueuedBytes > SOFT_MAX_BACKLOG_BYTES) {
        const head = outboundQueue.shift();
        if (!head) break;
        outboundQueuedBytes -= head.length;
        droppedOutboundBytes += head.length;
      }
      console.log("🗑️ Outbound audio drop (HARD backlog):", {
        outboundQueuedBytes,
        droppedOutboundBytes,
      });
    } else if (outboundQueuedBytes > SOFT_MAX_BACKLOG_BYTES && Math.random() < 0.05) {
      console.log("⏳ Outbound backlog (no drop):", {
        outboundQueuedBytes,
        approxSeconds: Math.round((outboundQueuedBytes / 160) * 0.02),
      });
    }
    outboundQueue.push(buf);
    outboundQueuedBytes += buf.length;
  }

  function sendOutboundFrames(maxFrames = 1) {
    if (!twilioStreamSid) return;
    let framesSent = 0;
    while (framesSent < maxFrames && outboundQueue.length > 0) {
      const head = outboundQueue[0];
      if (!head || head.length === 0) {
        outboundQueue.shift();
        continue;
      }

      const frameSize = 160; // 20ms μ-law @ 8kHz
      let frame;
      if (head.length <= frameSize) {
        frame = head;
        outboundQueue.shift();
      } else {
        frame = head.subarray(0, frameSize);
        outboundQueue[0] = head.subarray(frameSize);
      }

      outboundQueuedBytes -= frame.length;

      try {
        ws.send(JSON.stringify({
          event: "media",
          streamSid: twilioStreamSid,
          media: {
            payload: Buffer.from(frame).toString("base64"),
          },
        }));
        framesSent += 1;
      } catch (err) {
        console.error("❌ Erreur envoi frame audio à Twilio:", err);
        break;
      }
    }

    if (LOG_TWILIO_FRAMES && framesSent > 0 && Math.random() < 0.02) {
      console.log("📤 Frames audio envoyées à Twilio:", {
        streamSid: twilioStreamSid,
        framesSent,
        outboundQueuedBytes,
        queueLen: outboundQueue.length,
      });
    }
  }

  // Connecter à OpenAI Realtime API
  async function connectToOpenAI() {
    let connectionTimeout = null;
    if (!OPENAI_API_KEY) {
      console.error("❌ OpenAI API key manquante");
      return;
    }

    try {
      console.log("🔌 Tentative de connexion à OpenAI Realtime API...");
      // Configurer le format audio dans l'URL de connexion.
      // On force PCM16 pour éviter tout mismatch de format en sortie (sinon Twilio joue du bruit).
      // IMPORTANT: Utiliser le modèle configuré dans LLM_MODEL, mais pour Realtime API, on doit utiliser gpt-4o-realtime-preview
      // car GPT-5 n'a pas encore de Realtime API
      const realtimeModel = "gpt-4o-realtime-preview-2024-12-17"; // Realtime API utilise toujours ce modèle
      const openaiUrl =
        `wss://api.openai.com/v1/realtime?model=${realtimeModel}&input_audio_format=pcm16&output_audio_format=pcm16`;
      console.log("🔌 URL OpenAI:", openaiUrl.replace(/Bearer\s+\S+/, "Bearer ***"));
      console.log("🔌 OPENAI_API_KEY présente:", !!OPENAI_API_KEY);
      console.log("🔌 OPENAI_API_KEY longueur:", OPENAI_API_KEY ? OPENAI_API_KEY.length : 0);
      console.log("🔌 OPENAI_API_KEY préfixe:", OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 7) : "N/A");
      
      if (!OPENAI_API_KEY || OPENAI_API_KEY.trim().length === 0) {
        console.error("❌ OPENAI_API_KEY est vide ou manquante !");
        return;
      }
      
      // Vérifier que la clé commence par "sk-"
      const trimmedKey = OPENAI_API_KEY.trim();
      if (!trimmedKey.startsWith("sk-")) {
        console.error("❌ OPENAI_API_KEY ne commence pas par 'sk-' - format invalide !");
        console.error("❌ Préfixe reçu:", trimmedKey.substring(0, 10));
        return;
      }
      
      // Nettoyer l'ancienne connexion si elle existe
      if (openaiWs) {
        try {
          openaiWs.removeAllListeners();
          if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
            openaiWs.close();
          }
        } catch (e) {
          // ignore
        }
      }
      
      // Créer la connexion WebSocket avec gestion d'erreur immédiate
      try {
        openaiWs = new WebSocket(openaiUrl, {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY.trim()}`,
          },
        });
        
        console.log("🔌 WebSocket créé, état initial:", openaiWs.readyState);
      } catch (wsErr) {
        console.error("❌ Erreur création WebSocket:", wsErr);
        console.error("❌ Erreur détails:", {
          message: wsErr.message,
          code: wsErr.code,
          stack: wsErr.stack?.substring(0, 500),
        });
        return;
      }
      
      // Ajouter un timeout pour la connexion
      connectionTimeout = setTimeout(() => {
        if (openaiWs && openaiWs.readyState !== WebSocket.OPEN) {
          console.error("❌ Timeout connexion OpenAI WebSocket (10s)");
          console.error("❌ État WebSocket:", openaiWs.readyState);
          console.error("❌ États possibles: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED");
          if (openaiWs) {
            try {
              openaiWs.close();
            } catch (e) {
              // ignore
            }
          }
        }
      }, 10000);
      
      openaiWs.on("open", async () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        console.log("✅ Connecté à OpenAI Realtime API");
        console.log("🎛️ OpenAI audio format (forced):", { input: "pcm16", output: "pcm16" });
        console.log("📊 Configuration active:", {
          PIPELINE_MODE,
          REALTIME_USE_ELEVEN,
          PREMIUM_TTS_ENABLED,
          PREMIUM_TTS_PROVIDER,
          LLM_MODEL,
          ELEVENLABS_VOICE_ID: ELEVENLABS_VOICE_ID_FEMALE || ELEVENLABS_VOICE_ID_MALE || ELEVENLABS_VOICE_ID_DEFAULT,
          MINIMAX_VOICE_ID: MINIMAX_VOICE_ID_FEMALE || MINIMAX_VOICE_ID_MALE || MINIMAX_VOICE_ID_DEFAULT,
        });
        
        // Log état du fallback au démarrage
        if (REALTIME_USE_ELEVEN) {
          if (nowMs() < premiumTtsBypassUntilMs) {
            const remainingMinutes = Math.ceil((premiumTtsBypassUntilMs - nowMs()) / 60000);
            const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
            console.warn(`⚠️ FALLBACK ACTIF au démarrage: ${providerName} en erreur → audio OpenAI (~${remainingMinutes} min restantes)`);
            if (premiumTtsLastError) {
              console.error(`   Dernière erreur ${providerName}:`, premiumTtsLastError);
            }
          } else {
            const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
            console.log(`✅ ${providerName} actif (pas de fallback)`);
          }
        }
        
        // Configurer la session OpenAI
        // Note: input_audio_format et output_audio_format sont configurés dans l'URL WebSocket, pas ici
        const ASSISTANT_PERSONA = (process.env.ASSISTANT_PERSONA ?? "mecanicien").toLowerCase();
        const rawGarageName = String(garageName || "AutoGuru").trim();
        const garageLabel = /^garage\b/i.test(rawGarageName) ? rawGarageName : `Garage ${rawGarageName}`;

        const modeLine =
          appointmentMode === "none"
            ? "Mode rendez-vous: aucun (tu ne proposes pas de RDV, tu prends un message)."
            : appointmentMode === "internal"
              ? `Mode rendez-vous: interne (tu peux proposer un créneau, mais tu confirmes seulement après validation explicite du client).${garageClosed ? " IMPORTANT: Si le garage est fermé (selon les horaires d'ouverture), tu NE peux PAS prendre de rendez-vous. Tu dis que le garage est actuellement fermé et que quelqu'un rappellera pour proposer un créneau quand le garage sera ouvert." : ""}`
              : "Mode rendez-vous: demande (tu NE confirmes PAS de RDV, tu prends une demande et le garage rappelle pour confirmer).";

        const consentLine =
          consentRequired
            ? "Dès le début de l'appel, annonce: 'Cet appel est enregistré pour préparer votre arrivée au garage. Si vous refusez, vous pouvez raccrocher à tout moment.' Puis demande un oui/non."
            : "Consentement enregistrement: non requis.";

        // En mode "internal", on peut proposer de vrais créneaux: on précharge 2-3 suggestions.
        availableAppointmentSlotsLine = "";
        if (appointmentMode === "internal") {
          const slots = await fetchAvailableAppointmentSlots();
          if (slots.length > 0) {
            const pretty = slots
              .slice(0, 3)
              .map((s) => {
                const d = new Date(`${s.date}T00:00:00`);
                const dateStr = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                return `${dateStr} à ${s.time}`;
              })
              .join(" ; ");
            availableAppointmentSlotsLine = `Créneaux disponibles (planning du garage): ${pretty}.`;
          }
        }

        const hoursPolicyLine = `Horaires: l'assistant répond 24h/24 et 7j/7 pour vous aider. Le garage, lui, est ouvert selon les horaires d'ouverture ci-dessous (information).`;
        const hoursInfoLine = garageHoursText
          ? `Horaires d'ouverture du garage: ${garageHoursText}`
          : "";
        
        // Construire la ligne des jours de fermeture hebdomadaires
        let closedDaysLine = "";
        if (closedDaysText && closedDaysText.trim()) {
          closedDaysLine = `Jours de fermeture du garage: ${closedDaysText} Tu DOIS communiquer ces jours au client s'il demande un rendez-vous.`;
        }
        
        const closedInfoLine = garageClosed
          ? `Info horaires (interne): le garage est actuellement indiqué comme fermé. (${garageClosedReason || "closed"}) ${garageClosedText || ""} Tu NE le mentionnes PAS au début. Tu le mentionnes uniquement en fin d'appel, selon les règles ci-dessous.`
          : "Info horaires (interne): garage indiqué ouvert.";
        const hoursReminderLine =
          appointmentMode !== "none"
            ? (hoursInfoLine
              ? `AVANT de demander les préférences de rendez-vous, tu DOIS annoncer EXACTEMENT les horaires ci-dessous, sans en inventer d'autres: "${hoursInfoLine}".${closedDaysText ? ` Puis ajoute: "${closedDaysText}".` : ""} Ensuite, demande UNIQUEMENT le jour qui convient le mieux.`
              : `AVANT de demander les préférences de rendez-vous, tu dis: "Je n'ai pas les horaires exacts dans nos réglages." Puis tu demandes le jour qui convient le mieux.`)
            : "";
        const pricingLine = pricingSummary
          ? `Tarifs du garage (à utiliser si le client demande un prix, sans inventer): ${pricingSummary}
IMPORTANT: Si un tarif contient "(le prix peut varier selon le véhicule)", tu DOIS donner le prix indiqué ET préciser que le prix peut varier selon le véhicule. Ajoute ensuite: "Tout sera inscrit lorsque vous aurez établi le devis avec le garage." ou une phrase similaire. Exemple: "Pour une vidange, c'est environ 45€, mais le prix peut varier selon le véhicule. Tout sera inscrit lorsque vous aurez établi le devis avec le garage."`
          : "Tarifs du garage: non renseignés (si le client demande un prix, tu expliques que c'est sur devis ou à confirmer).";

        const servicesLine = servicesSummary
          ? `Services disponibles au garage (utilise ces infos pour répondre aux questions): ${servicesSummary}`
          : "";

        const faqsLine = faqsSummary
          ? `Questions fréquentes (utilise ces réponses si le client pose une question similaire): ${faqsSummary}`
          : "";

        // Construire la section infos client pour le prompt
        const buildClientInfoLine = () => {
          if (!clientInfo || !clientInfo.name) return "";
          
          const appointments = clientInfo.appointments || [];
          const appointmentsText = appointments.length > 0
            ? appointments.map((apt) => {
                const date = new Date(apt.appointment_date);
                const dateStr = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const service = apt.service_requested ? ` (${apt.service_requested})` : "";
                return `- ${dateStr} à ${apt.appointment_time}${service}`;
              }).join("\n")
            : "Aucun rendez-vous à venir.";
          
          const clientPlate = clientInfo.plate ? String(clientInfo.plate).trim() : null;
          const clientPlate2 = clientInfo.plate_2 ? String(clientInfo.plate_2).trim() : null;
          let plateInfo = "";
          if (clientPlate && clientPlate2) {
            plateInfo = `Plaques d'immatriculation enregistrées: ${clientPlate} (principale) et ${clientPlate2} (secondaire).`;
          } else if (clientPlate) {
            plateInfo = `Plaque d'immatriculation enregistrée: ${clientPlate}`;
          } else {
            plateInfo = "Aucune plaque d'immatriculation enregistrée.";
          }
          
          const firstName = clientInfo.first_name ? String(clientInfo.first_name).trim() : null;
          const lastName = clientInfo.last_name ? String(clientInfo.last_name).trim() : null;
          const gender = clientInfo.gender ? String(clientInfo.gender).trim() : null;
          
          const nameDetails = [];
          if (firstName) nameDetails.push(`Prénom: ${firstName}`);
          if (lastName) nameDetails.push(`Nom: ${lastName}`);
          if (gender && gender !== "indéterminé") nameDetails.push(`Genre: ${gender}`);
          
          const title = gender === "homme" ? "Monsieur" : gender === "femme" ? "Madame" : "";
          // Utiliser uniquement le nom de famille (last_name), pas le nom complet
          let salutationName = lastName ? String(lastName).trim() : null;
          // Si pas de last_name, extraire le dernier mot du nom complet comme fallback
          if (!salutationName && clientInfo.name) {
            const nameParts = clientInfo.name.split(/\s+/);
            salutationName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : clientInfo.name;
          }
          const salutationText = title && salutationName ? `${title} ${salutationName}` : salutationName || "";
          
          return `DÉTECTION CLIENT:
Le numéro qui appelle fait partie des dossiers clients du garage.
Nom complet: ${clientInfo.name}
${nameDetails.length > 0 ? nameDetails.join(", ") + "\n" : ""}${plateInfo}
Rendez-vous à venir:
${appointmentsText}

IMPORTANT - SALUTATION:
- Tu DOIS saluer le client avec respect en utilisant le titre approprié ET le NOM DE FAMILLE uniquement (pas le prénom ni le nom complet): "${salutationText}" (ex: "Bonjour ${title} ${salutationName}" ou "Bonjour ${salutationName}" si genre indéterminé).
- Utilise UNIQUEMENT le nom de famille (${salutationName}) dans la salutation, PAS le prénom, PAS le nom complet.
- Utilise "${title}" si le genre est défini (${gender || "non défini"}), sinon utilise simplement le nom de famille.

IMPORTANT - GESTION DE LA PLAQUE D'IMMATRICULATION (À LIRE EN PREMIER):
- NE propose JAMAIS un message pour la plaque juste après le consentement ou sans avoir compris ce que le client veut.
- Tu DOIS D'ABORD comprendre le besoin du client (diagnostic, problème, rendez-vous, etc.) AVANT de parler de plaque.
- AVANT de proposer un message pour la plaque, tu DOIS TOUJOURS vérifier la section "DÉTECTION CLIENT" ci-dessus.
- Si le client a déjà une plaque enregistrée (voir "Plaque d'immatriculation enregistrée" ci-dessus):
  * Lors de la prise de rendez-vous UNIQUEMENT, tu DOIS TOUJOURS lire la plaque principale pour confirmation AVANT de finaliser le rendez-vous: "Je vois que vous êtes déjà dans nos dossiers. Votre plaque d'immatriculation est ${clientPlate}. Est-ce bien correct ?"
  * Si le client confirme que c'est la bonne plaque (ex: "oui", "c'est ça", "correct"), utilise cette plaque pour le rendez-vous.
  * Si le client dit que ce n'est PAS la bonne plaque (ex: "non", "ce n'est pas la bonne", "j'ai changé de voiture", "c'est une autre voiture"), alors tu proposes immédiatement d'envoyer un message pour qu'il envoie la bonne plaque: "D'accord, je vais vous envoyer un message pour que vous puissiez m'indiquer votre nouvelle plaque d'immatriculation." (La nouvelle plaque sera automatiquement enregistrée comme plaque secondaire dans le dossier client).
- Si le client a plusieurs plaques enregistrées (plaque principale et plaque secondaire), lors de la prise de rendez-vous, tu lis d'abord la plaque principale et demandes confirmation. Si le client dit que ce n'est pas la bonne, tu proposes d'envoyer un message pour qu'il indique quelle plaque utiliser.
- Si le client n'a PAS de plaque enregistrée (voir "Aucune plaque d'immatriculation enregistrée" ci-dessus), tu proposes d'envoyer un message pour qu'il envoie sa plaque UNIQUEMENT si le client demande un rendez-vous (NE PAS demander la plaque à l'oral, NE PAS proposer de message avant de comprendre le besoin).
- RÈGLE ABSOLUE: Ne propose JAMAIS un message pour la plaque si le client a déjà une plaque enregistrée SANS avoir d'abord lu la plaque et demandé confirmation. Annonce directement la plaque enregistrée et demande confirmation.
- RÈGLE ABSOLUE: Ne propose JAMAIS un message pour la plaque juste après le consentement ou avant d'avoir compris ce que le client veut. Attends que le client mentionne un besoin concret (rendez-vous, diagnostic, etc.).

IMPORTANT - GESTION DES RENDEZ-VOUS:
- Si le client appelle pour MODIFIER un rendez-vous: détecte sa demande et demande la nouvelle date/heure souhaitée.
  * Si mode rendez-vous = "interne": tu peux modifier directement le rendez-vous et confirmer.
  * Si mode rendez-vous = "demande" ou "aucun": tu notes la demande de modification et dis: "J'ai bien noté votre demande de modification. Le garage vous rappellera pour confirmer la nouvelle date et heure."
- Si le client appelle pour ANNULER un rendez-vous: détecte sa demande.
  * Si mode rendez-vous = "interne": tu peux annuler directement le rendez-vous et confirmer.
  * Si mode rendez-vous = "demande" ou "aucun": tu notes la demande d'annulation et dis: "J'ai bien noté votre demande d'annulation. Le garage vous rappellera pour confirmer."
- Si le client demande s'il a un rendez-vous: informe-le des rendez-vous à venir listés ci-dessus.
- Si le client ne mentionne pas modification/annulation, procède normalement (diagnostic, nouveau RDV, etc.).

Tu dois DÉTECTER automatiquement si le client mentionne "modifier", "changer", "déplacer" pour un rendez-vous, ou "annuler", "annulation" pour un rendez-vous.`;
        };
        
        const clientInfoLine = buildClientInfoLine();

        const baseInstructions = `Tu es ${assistantName}, l'assistant(e) téléphonique de ${garageLabel}.
Tu réponds à des appels téléphoniques (style oral, naturel, vivant).
Objectif: comprendre précisément le besoin, rassurer, puis proposer la suite adaptée.
${modeLine}
${consentLine}
${hoursPolicyLine}
${hoursInfoLine ? `${hoursInfoLine}\n` : ""}
${availableAppointmentSlotsLine ? `${availableAppointmentSlotsLine}\n` : ""}
${closedInfoLine}
${closedDaysLine ? `${closedDaysLine}\n` : ""}${pricingLine}
${servicesLine ? `${servicesLine}\n` : ""}${faqsLine ? `${faqsLine}\n` : ""}${clientInfoLine ? `${clientInfoLine}\n\n` : ""}${hoursReminderLine ? `${hoursReminderLine}\n` : ""}RÈGLES D'ÉCOUTE:
- Tu écoutes et tu réponds à CE QUE le client dit (pas de scénarios pré-écrits).
- Si le client dit "non", tu t'arrêtes et tu confirmes: "D'accord, pas de souci." puis tu proposes une alternative.
- Si c'est ambigu, tu poses UNE question simple de clarification.

OBJECTIF (ACCOMPAGNEMENT):
- Tu aides le client à mieux comprendre son problème en posant des questions simples, une par une.
- Tu guides petit à petit vers la meilleure suite: conseil sécurité / dépôt / ou rendez-vous.
- Si le client sait exactement ce qu'il veut (ex: "je veux une vidange", "je veux un devis", "je veux un rendez-vous"), tu vas droit au but et tu réduis les questions.

RÈGLE ANTI-INVENTION (TRÈS IMPORTANT):
- La plupart des informations viennent des réglages IA (Tarifs du garage, Services disponibles, Questions fréquentes, Horaires).
- Tu NE DOIS PAS inventer d'informations sur le garage (prix, contenu exact d'une prestation, délais, conditions).
- Si une info n'est pas renseignée, tu dis clairement: "Je n'ai pas l'information exacte dans nos réglages" et tu proposes la suite (devis / rappel / passage au garage).
- Tu peux donner une explication générique UNIQUEMENT si ça aide le client à comprendre son problème (et tu précises que ça peut varier selon le véhicule).

RENSEIGNEMENTS SUR LES PRESTATIONS (IMPORTANT):
- Si le client demande un renseignement sur une prestation (ex: révision, vidange, freins), tu expliques en termes simples ce que ça permet.
- Pour une révision: dis ce qui est généralement compris (contrôles de sécurité, niveaux, filtres selon formule, diagnostic visuel) et ce que le garage vérifie.
- Utilise en priorité les sections "Services disponibles", "Questions fréquentes" et "Tarifs du garage" ci-dessus. Si une info n'est pas renseignée, tu donnes une explication générique et tu précises que ça peut varier selon le véhicule.

DIAGNOSTIC GUIDÉ (si le client ne sait pas exactement):
- Tu poses plusieurs questions courtes (une par une) pour aider le client à identifier le problème et mieux le comprendre.
- Priorité des questions: symptôme principal → depuis quand → conditions (à froid/chaud, en roulant, en freinant, en tournant) → voyants → urgence/sécurité.
- Tu peux proposer 1 à 2 pistes fréquentes ("ça peut venir de...") mais tu précises que c'est à confirmer au garage.

INTENTION RDV:
- Tu ne lances JAMAIS une demande de rendez-vous si le client n'a pas demandé de rendez-vous.
- Tu déclenches le mode RDV uniquement si le client dit explicitement qu'il veut un rendez-vous ou un créneau.

STYLE (échange humain):
- Parle comme au téléphone avec une vraie personne: naturel, simple, fluide.
- Réponses courtes (1 à 2 phrases), puis UNE question.
- Réagis au contenu exact du client (reformule 1 élément clé).
- Si le client répond, tu enchaînes logiquement (pas de bloc pré-écrit).
- Utilise la ponctuation pour sonner naturel.`;

        const mechanicPersona =
          `Persona: tu es ${assistantName}, une vraie personne au téléphone (pas un robot).
Tu mets à l'aise, tu écoutes, tu réagis naturellement.
${garageTone ? `Ton du garage (à respecter): ${garageTone}` : ""}

Méthode:
1) Comprendre le besoin en 1 phrase ("ok, je vois").
2) Poser des questions courtes, une par une. (Tu peux aller jusqu'à 4-5 questions si c'est nécessaire pour préparer le garage.)
3) Reformuler en 1 phrase.
4) Proposer la suite: conseil sécurité / dépôt / ou rendez-vous si le client le demande.

Checklist utile (à utiliser seulement si pertinent, sans interrogatoire):
- Symptôme principal (bruit, voyant, fuite, démarrage, freinage, clim, etc.)
- Depuis quand / fréquence
- Conditions (à froid/chaud, en roulant, en freinant, en tournant)
- Urgence/sécurité (voyant rouge, perte de puissance, fuite importante)
- Kilométrage approximatif (si utile)

Règles de langage:
- Vouvoiement par défaut.
- Ne dis jamais que tu es une IA.
- Si tu n'as pas compris: "Pardon, je n'ai pas bien compris. Pouvez-vous reformuler ?"
- Attends toujours une réponse claire avant de continuer.`;

        // IMPORTANT: Ne plus demander le modèle de véhicule, uniquement la plaque si nécessaire
        const vehicleInfoRule = `- Tu NE demandes PAS le modèle de véhicule (marque/modèle/année). Tu demandes UNIQUEMENT la plaque d'immatriculation si nécessaire.`;

        const hardConstraints =
          `IMPORTANT:
- Tu es un garage auto. Tu parles UNIQUEMENT de véhicules/diagnostic/rendez-vous.
- Tu ne fais PAS de suppositions. Tu réponds strictement à ce que le client demande.
- Si le client dit "non", tu confirmes et tu n'insistes pas. Tu proposes une alternative simple.

PLAQUE D'IMMATRICULATION (RÈGLE ABSOLUE):
1) Vérifie TOUJOURS "DÉTECTION CLIENT".
2) Si plaque existante: annonce la plaque et demande confirmation. Ne propose PAS de message.
3) Si pas de plaque: propose d'envoyer un message. Ne demande PAS la plaque à l'oral.
4) Attends un OUI clair avant d'envoyer le message.

PROCÉDURE RDV (OBLIGATOIRE ET DANS CET ORDRE):
1) Annonce les horaires d'ouverture (et jours de fermeture si disponibles).
2) Demande le JOUR qui convient le mieux.
3) APRÈS la réponse, demande: "plutôt le matin ou l'après-midi ?"

RÈGLES RDV:
- Ne lance JAMAIS une demande de rendez-vous si le client n'en a pas demandé.
- Si mode rendez-vous = demande: tu notes la demande, tu ne confirmes jamais.
- Si mode rendez-vous = aucun: tu prends un message, tu ne proposes pas de RDV.
- Si mode rendez-vous = interne et garage fermé: tu dis qu'une personne rappellera, sans proposer de créneau.
- Si mode rendez-vous = interne et que la ligne "Créneaux disponibles (planning du garage)" est présente dans les instructions:
  * Tu proposes 1 à 3 créneaux parmi ceux listés, et tu demandes lequel convient.
  * Tu confirmes seulement après validation explicite du client.

TARIFS:
- Si un tarif est renseigné, tu le donnes et tu précises si le prix peut varier selon le véhicule.
- Sinon, tu dis que c'est à confirmer/devis.

AUTRES:
${vehicleInfoRule}
- Tu n'inventes JAMAIS une plaque. Si doute: demander de répéter.`;

        const closingGuidelines =
          `Fin d'appel:
- Avant de conclure, dis: "Donnez juste votre numéro de téléphone à l'accueil pour faciliter votre arrivée au garage."
- En mode demande RDV: rappelle que le garage vous rappelle pour confirmer.
${garageClosed
  ? (appointmentMode === "internal"
      ? `- IMPORTANT: en toute fin, ajoute UNE phrase d'info: "À noter, le garage est actuellement fermé; j'ai bien enregistré votre demande/rdv et une personne vous rappellera si besoin."`
      : `- IMPORTANT: en toute fin, ajoute UNE phrase d'info: "À noter, le garage est actuellement fermé; une personne vous rappellera pour confirmer."`)
  : ""}`;

        const variationGuidelines =
          `Variation:
- Varie tes formulations et ton accueil (évite les répétitions mot pour mot).
- Tu peux alterner "Bonjour", "Salut", "Oui allô", mais reste professionnel.
- N'enchaîne pas deux fois "Garage X, bonjour" dans la même phrase.`;

        const neutralPersona =
          `Persona: assistant téléphonique professionnel, cordial, chaleureux et concis.`;

        // IMPORTANT: sur notre modèle Realtime actuel, `session.input_audio_transcription` n'est PAS supporté
        // (Render logs: unknown_parameter). On le désactive par défaut.
        const REALTIME_INPUT_TRANSCRIPTION_ENABLED = (process.env.REALTIME_INPUT_TRANSCRIPTION_ENABLED ?? "false").toLowerCase() === "true";
        const REALTIME_INPUT_TRANSCRIPTION_MODEL = process.env.REALTIME_INPUT_TRANSCRIPTION_MODEL ?? "whisper-1";
        const REALTIME_INPUT_TRANSCRIPTION_LANGUAGE = process.env.REALTIME_INPUT_TRANSCRIPTION_LANGUAGE ?? "fr";

        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `${baseInstructions}\n\n${ASSISTANT_PERSONA === "mecanicien" ? mechanicPersona : neutralPersona}`,
            // Utiliser "text" au lieu de "audio" car on utilise Minimax/ElevenLabs pour le TTS
            // Cela permet d'obtenir directement le texte pour le passer au TTS premium
            output_modalities: ["text"],
            // Les formats audio sont configurés dans l'URL WebSocket (input_audio_format et output_audio_format)
          },
        };
        if (REALTIME_INPUT_TRANSCRIPTION_ENABLED) {
          sessionUpdate.session.input_audio_transcription = {
            model: REALTIME_INPUT_TRANSCRIPTION_MODEL,
            language: REALTIME_INPUT_TRANSCRIPTION_LANGUAGE,
          };
        }
        // Fonction pour mettre à jour le prompt avec les infos client (si récupérées après)
        const updatePromptWithClientInfo = () => {
          console.log("🔄 updatePromptWithClientInfo appelée:", {
            hasClientInfo: !!clientInfo,
            hasOpenAI: !!openaiWs,
            openAIState: openaiWs?.readyState,
            clientName: clientInfo?.name || "N/A",
            clientPlate: clientInfo?.plate || "Aucune",
          });
          
          if (!clientInfo) {
            console.warn("⚠️ Pas d'infos client disponibles pour mise à jour prompt");
            return;
          }
          
          if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
            console.warn("⚠️ OpenAI WebSocket pas connecté (état:", openaiWs?.readyState, ")");
            return;
          }
          
          const newClientInfoLine = buildClientInfoLine();
          if (!newClientInfoLine) {
            console.warn("⚠️ buildClientInfoLine retourne vide");
            return;
          }
          
          console.log("📋 Section DÉTECTION CLIENT générée:", newClientInfoLine.substring(0, 400));
          
          // Reconstruire baseInstructions avec les nouvelles infos client
          const updatedBaseInstructions = `Tu es ${assistantName}, l'assistant(e) téléphonique de ${garageLabel}.
Tu réponds à des appels téléphoniques (style oral, naturel, vivant).
Objectif: comprendre précisément le besoin, rassurer, puis proposer la suite adaptée.
${modeLine}
${consentLine}
${hoursPolicyLine}
${hoursInfoLine ? `${hoursInfoLine}\n` : ""}
${availableAppointmentSlotsLine ? `${availableAppointmentSlotsLine}\n` : ""}
${closedInfoLine}
${closedDaysLine ? `${closedDaysLine}\n` : ""}${pricingLine}
${servicesLine ? `${servicesLine}\n` : ""}${faqsLine ? `${faqsLine}\n` : ""}${newClientInfoLine}\n\n${hoursReminderLine ? `${hoursReminderLine}\n` : ""}RÈGLES D'ÉCOUTE:
- Tu écoutes et tu réponds à CE QUE le client dit (pas de scénarios pré-écrits).
- Si le client dit "non", tu t'arrêtes et tu confirmes: "D'accord, pas de souci." puis tu proposes une alternative.
- Si c'est ambigu, tu poses UNE question simple de clarification.

OBJECTIF (ACCOMPAGNEMENT):
- Tu aides le client à mieux comprendre son problème en posant des questions simples, une par une.
- Tu guides petit à petit vers la meilleure suite: conseil sécurité / dépôt / ou rendez-vous.
- Si le client sait exactement ce qu'il veut (ex: "je veux une vidange", "je veux un devis", "je veux un rendez-vous"), tu vas droit au but et tu réduis les questions.

RÈGLE ANTI-INVENTION (TRÈS IMPORTANT):
- La plupart des informations viennent des réglages IA (Tarifs du garage, Services disponibles, Questions fréquentes, Horaires).
- Tu NE DOIS PAS inventer d'informations sur le garage (prix, contenu exact d'une prestation, délais, conditions).
- Si une info n'est pas renseignée, tu dis clairement: "Je n'ai pas l'information exacte dans nos réglages" et tu proposes la suite (devis / rappel / passage au garage).
- Tu peux donner une explication générique UNIQUEMENT si ça aide le client à comprendre son problème (et tu précises que ça peut varier selon le véhicule).

RENSEIGNEMENTS SUR LES PRESTATIONS (IMPORTANT):
- Si le client demande un renseignement sur une prestation (ex: révision, vidange, freins), tu expliques en termes simples ce que ça permet.
- Pour une révision: dis ce qui est généralement compris (contrôles de sécurité, niveaux, filtres selon formule, diagnostic visuel) et ce que le garage vérifie.
- Utilise en priorité les sections "Services disponibles", "Questions fréquentes" et "Tarifs du garage" ci-dessus. Si une info n'est pas renseignée, tu donnes une explication générique et tu précises que ça peut varier selon le véhicule.

INTENTION RDV:
- Tu ne lances JAMAIS une demande de rendez-vous si le client n'a pas demandé de rendez-vous.
- Tu déclenches le mode RDV uniquement si le client dit explicitement qu'il veut un rendez-vous ou un créneau.

STYLE (échange humain):
- Parle comme au téléphone avec une vraie personne: naturel, simple, fluide.
- Réponses courtes (1 à 2 phrases), puis UNE question.
- Réagis au contenu exact du client (reformule 1 élément clé).
- Si le client répond, tu enchaînes logiquement (pas de bloc pré-écrit).
- Utilise la ponctuation pour sonner naturel.`;
          
          const updatedInstructions = `${updatedBaseInstructions}\n\n${ASSISTANT_PERSONA === "mecanicien" ? mechanicPersona : neutralPersona}\n\n${variationGuidelines}\n\n${hardConstraints}\n\n${closingGuidelines}`;
          
          openaiWs.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: updatedInstructions,
              // Utiliser "text" pour obtenir le texte directement (TTS via Minimax/ElevenLabs)
              output_modalities: ["text"],
            },
          }));
          ws.__sessionInstructions = String(updatedInstructions || "");
          console.log("✅ Prompt mis à jour avec infos client", {
            hasClientInfo: !!clientInfo,
            hasPlate: !!clientInfo?.plate,
            plate: clientInfo?.plate || "Aucune",
            clientName: clientInfo?.name || "N/A",
            promptLength: updatedInstructions.length,
          });
        };
        
        // On ajoute des contraintes fortes (évite les réponses "hors sujet" type coach de vie).
        sessionUpdate.session.instructions =
          `${baseInstructions}\n\n${ASSISTANT_PERSONA === "mecanicien" ? mechanicPersona : neutralPersona}\n\n${variationGuidelines}\n\n${hardConstraints}\n\n${closingGuidelines}`;
        // Stocke pour fallback en cas de unknown_parameter (session.update partiellement appliquée)
        ws.__sessionInstructions = String(sessionUpdate.session.instructions || "");
        
        // Stocker la fonction pour mise à jour ultérieure
        ws.__updatePromptWithClientInfo = updatePromptWithClientInfo;

        openaiWs.send(JSON.stringify(sessionUpdate));

        function pickGreetingText(label) {
          const clientName = clientInfo?.name ? String(clientInfo.name).trim() : null;
          if (clientName && clientInfo) {
            // Utiliser uniquement le nom de famille (last_name), pas le nom complet
            let lastName = clientInfo.last_name ? String(clientInfo.last_name).trim() : null;
            // Si pas de last_name, extraire le dernier mot du nom complet comme fallback
            if (!lastName || lastName === "") {
              const nameParts = clientName.split(/\s+/).filter(p => p.trim().length > 0);
              lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : (nameParts.length === 1 ? nameParts[0] : clientName);
            }
            const gender = clientInfo.gender ? String(clientInfo.gender).trim() : null;
            
            // Déterminer le titre selon le genre
            const title = gender === "homme" ? "Monsieur" : gender === "femme" ? "Madame" : null;
            // Construire salutationName avec le nom de famille ou le nom complet en fallback
            let salutationName = "";
            if (lastName && lastName.trim().length > 0) {
              salutationName = title ? `${title} ${lastName}` : lastName;
            } else {
              salutationName = title ? `${title} ${clientName}` : clientName;
            }
            
            // Si le client est détecté, saluer avec le titre approprié
            const greetingsWithName = [
              `Bonjour ${salutationName} ! Je suis ${assistantName}, l'assistante du ${label}. En quoi puis-je vous aider ?`,
              `Bonjour ${salutationName}, ${assistantName} à l'appareil, du ${label}. Qu'est-ce qui vous amène ?`,
              `Bonjour ${salutationName} ! Ici ${assistantName}, du ${label}. Dites-moi ce qui se passe avec votre voiture.`,
              `Bonjour ${salutationName}, vous êtes bien au ${label}. Je suis ${assistantName}. En quoi je peux vous aider ?`,
            ];
            return greetingsWithName[Math.floor(Math.random() * greetingsWithName.length)];
          }
          const greetings = [
            `Bonjour ! Je suis ${assistantName}, l'assistante du ${label}. En quoi puis-je vous aider ?`,
            `Bonjour, ${assistantName} à l'appareil, du ${label}. Qu'est-ce qui vous amène ?`,
            `Bonjour ! Ici ${assistantName}, du ${label}. Dites-moi ce qui se passe avec votre voiture.`,
            `Bonjour, vous êtes bien au ${label}. Je suis ${assistantName}. En quoi je peux vous aider ?`,
            `Bonjour ! Je suis ${assistantName} du ${label}. C'est un bruit, un voyant, ou un souci au démarrage ?`,
          ];
          return greetings[Math.floor(Math.random() * greetings.length)];
        }

        // Si on a déjà joué un greeting local (TTS premium) avant l'ouverture OpenAI,
        // on l'injecte dans la conversation pour éviter que le modèle le répète.
        // IMPORTANT: Normaliser le texte pour cohérence de prononciation avec le TTS premium
        if (initialAssistantGreetingText && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          try {
            // Normaliser le texte pour que les mots soient prononcés de la même manière
            // dans la phrase d'accueil (ElevenLabs) et dans le reste de la conversation (OpenAI -> ElevenLabs)
            const normalizedGreeting = normalizeFrenchTtsText(initialAssistantGreetingText);
            openaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                // Realtime: pour un message assistant, le type attendu est "output_text"
                content: [{ type: "output_text", text: normalizedGreeting }],
              },
            }));
          } catch (e) {
            console.error("❌ Erreur injection greeting assistant:", e);
          }
        }

        // IMPORTANT: faire parler l'IA tout de suite (valide le chemin audio Twilio <- OpenAI),
        // même si le client n'a pas encore parlé / même si le VAD n'a pas commit.
        if (!hasSentInitialGreeting) {
          hasSentInitialGreeting = true;
          const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "80");
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          setTimeout(() => {
            try {
              if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
              // Si le client parle, on laisse l'anti-overlap retarder l'audio, mais on ne skip plus le greeting
              // (les flags OpenAI speech_started peuvent être trop sensibles et faire sauter l'accueil).
              if (responseInProgress) return;
              // Éviter de rejouer l'accueil si Twilio reconnecte pendant le même CallSid
              if (greetOncePerCall && hasGreetedRecently(callSid)) {
                console.log("👋 Greeting ignoré (déjà joué pour ce CallSid).", { callSid });
                return;
              }

              // Si on a déjà joué un greeting local (TTS premium), ne pas en redemander un à OpenAI.
              if (initialAssistantGreetingText) {
                const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
                console.log(`👋 Greeting OpenAI ignoré (greeting déjà joué via ${providerName}).`, { callSid });
                if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
                return;
              }

              openaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text:
                        `Commence l'appel comme un mécanicien au téléphone, très humain.
Voici une suggestion d'accueil (tu peux la dire telle quelle, sans la répéter deux fois):
"${pickGreetingText(garageLabel)}"
Ensuite: pose UNE question simple si besoin.
But: être naturel et mettre le client en confiance.`,
                    },
                  ],
                },
              }));
              requestResponseCreate("greeting");
              console.log("👋 Greeting demandé à OpenAI (response.create).");
              if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
            } catch (err) {
              console.error("❌ Erreur envoi greeting à OpenAI:", err);
            }
          }, greetingDelayMs);
        }

        // Flush des frames reçues avant l'ouverture OpenAI
        if (preOpenFrames.length > 0) {
          const flushedBytes = preOpenBytes;
          console.log("⏩ Flush pre-open frames -> OpenAI:", {
            frames: preOpenFrames.length,
            bytes: flushedBytes,
            fmt: "pcm16",
          });
          for (const f of preOpenFrames) {
            // f.audioBase64 est du μ-law (Twilio). Convertir en PCM16 24kHz avant d'append.
            const mulawBuffer = Buffer.from(f.audioBase64, "base64");
            const pcm24k = convertMulawToPcm24k(mulawBuffer);
            const pcm24kBuffer = Buffer.allocUnsafe(pcm24k.length * 2);
            for (let i = 0; i < pcm24k.length; i++) {
              pcm24kBuffer.writeInt16LE(pcm24k[i], i * 2);
            }
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm24kBuffer.toString("base64"),
            }));
            appendedBytes += pcm24kBuffer.length;
          }
          preOpenFrames = [];
          preOpenBytes = 0;
        }
      });

      openaiWs.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Stockage du texte de réponse (pour mode TTS premium)
          // Map<response_id, transcript>
          if (!ws.__premiumTranscriptByResponseId) ws.__premiumTranscriptByResponseId = new Map();
          const transcriptMap = ws.__premiumTranscriptByResponseId;
          // Anti-doublon: certains events transcript peuvent arriver plusieurs fois
          if (!ws.__realtimeSpokenResponseId) ws.__realtimeSpokenResponseId = new Set();
          const spokenSet = ws.__realtimeSpokenResponseId;
          // Etat du chunking ElevenLabs en Realtime
          if (!ws.__realtimeElevenStateByResponseId) ws.__realtimeElevenStateByResponseId = new Map();
          const elevenStateMap = ws.__realtimeElevenStateByResponseId;

          /**
           * Extraction robuste de texte depuis la structure "response.output"
           * de l'API Realtime (le format varie souvent entre les versions).
           */
          // Extraction générique de texte depuis une structure arbitraire (response.output, item.content, etc.)
          function extractTextFromResponseOutput(output, maxLen = 4000) {
            let collected = "";
            const visited = new Set();
            const TEXT_TYPES = new Set(["text", "output_text", "input_text"]);
            const BLOCKED_STRINGS = /^(output|output_text|output_item|message|messaging|text|content|assistant|user|system)$/i;

            function addText(str) {
              if (!str) return;
              if (collected.length >= maxLen) return;
              const s = String(str);
              if (!s) return;
              // Éviter de collecter des labels techniques
              if (BLOCKED_STRINGS.test(s.trim())) return;
              collected += s;
            }

            function walk(node, depth) {
              if (!node || collected.length >= maxLen) return;
              if (depth > 6) return; // éviter les cycles profonds
              if (typeof node === "string") {
                // N'ajouter que si ça ressemble à du texte humain
                const t = node.trim();
                if (t.length >= 3 && /[a-zàâçéèêëîïôûùüÿœ]/i.test(t)) {
                  addText(t);
                }
                return;
              }
              if (typeof node !== "object") return;
              if (visited.has(node)) return;
              visited.add(node);

              if (Array.isArray(node)) {
                for (const item of node) walk(item, depth + 1);
                return;
              }

              if (typeof node.text === "string") addText(node.text);
              if (typeof node.output_text === "string") addText(node.output_text);
              if (typeof node.transcript === "string") addText(node.transcript);

              if (Array.isArray(node.content)) {
                for (const c of node.content) {
                  if (c && typeof c === "object") {
                    if (TEXT_TYPES.has(c.type) && typeof c.text === "string") {
                      addText(c.text);
                    } else {
                      walk(c, depth + 1);
                    }
                  } else if (typeof c === "string") {
                    addText(c);
                  }
                }
              }
            }

            walk(output, 0);
            return collected.trim();
          }

          function flushRealtimeElevenChunks(rid, final = false) {
            if (!REALTIME_USE_ELEVEN || !REALTIME_ELEVEN_CHUNKING_ENABLED) return;
            if (!rid) return;
            const full = String(transcriptMap.get(rid) || "");
            const st = elevenStateMap.get(rid) || { cursor: 0, started: false };
            if (!full || st.cursor >= full.length) {
              if (final) elevenStateMap.delete(rid);
              else elevenStateMap.set(rid, st);
              return;
            }

            let remaining = full.slice(st.cursor);

            // Tant qu'on a une phrase complète (ou un gros chunk), on envoie.
            while (remaining.length >= REALTIME_ELEVEN_CHUNK_MIN_CHARS) {
              // Cherche une ponctuation pour couper naturellement
              const punctMatch = remaining.slice(0, REALTIME_ELEVEN_CHUNK_MAX_CHARS).match(/[\.\!\?\…]\s|[\n\r]+/);
              let cutIdx = -1;
              if (punctMatch && punctMatch.index != null) {
                cutIdx = punctMatch.index + punctMatch[0].length;
              } else if (remaining.length >= REALTIME_ELEVEN_CHUNK_MAX_CHARS) {
                // fallback: couper près d'un espace pour éviter de casser des mots
                const window = remaining.slice(0, REALTIME_ELEVEN_CHUNK_MAX_CHARS);
                const lastSpace = window.lastIndexOf(" ");
                cutIdx = lastSpace > 40 ? lastSpace : REALTIME_ELEVEN_CHUNK_MAX_CHARS;
              } else {
                break;
              }

              const chunk = remaining.slice(0, cutIdx).trim();
              if (chunk.length >= REALTIME_ELEVEN_CHUNK_MIN_CHARS || st.started) {
                // Dès qu'on commence à parler sur ce response_id, on le marque pour éviter les doublons.
                spokenSet.add(rid);
                // Ne pas interrompre si on a déjà commencé à parler (évite les coupures)
                enqueueElevenLabsTts(chunk, { interrupt: !st.started });
                st.started = true;
                st.cursor += cutIdx;
                remaining = full.slice(st.cursor);
              } else {
                break;
              }
            }

            if (final) {
              const tail = String(full.slice(st.cursor)).trim();
              if (tail) {
                spokenSet.add(rid);
                enqueueElevenLabsTts(tail, { interrupt: !st.started });
              }
              elevenStateMap.delete(rid);
            } else {
              elevenStateMap.set(rid, st);
            }
          }
          
          // Logger tous les types de messages pour debug
          // (On loggue aussi certains "delta" pour diagnostiquer l'audio sans spammer)
          if (msg.type) {
            const isDelta = msg.type.includes("delta");
            const shouldLogDelta = isDelta && Math.random() < 0.01; // ~1%
            if (!isDelta || shouldLogDelta) {
              console.log(
                "📨 OpenAI message:",
                msg.type,
                JSON.stringify({ keys: Object.keys(msg).slice(0, 15) }).substring(0, 200),
              );
            }
          }
          
          if (msg.type === "response.audio_transcript.done") {
            console.log("📝 Transcription IA:", msg.transcript);
          }
          
          // Transcripts de sortie (utile pour TTS premium) via events response.*
          if (msg.type === "response.created") {
            const rid = msg.response?.id ?? msg.response_id ?? null;
            const outputModalities = msg.response?.output_modalities || [];
            const hasAudioModality = Array.isArray(outputModalities) && outputModalities.includes("audio");
            console.log("📨 response.created reçu:", {
              rid,
              outputModalities,
              hasAudioModality,
              responseKeys: msg.response ? Object.keys(msg.response) : [],
              REALTIME_USE_ELEVEN,
            });
            if (!hasAudioModality && !REALTIME_USE_ELEVEN) {
              console.warn("⚠️ ATTENTION: response.created sans modalité audio et REALTIME_USE_ELEVEN=false !");
            }
            if (rid) transcriptMap.set(rid, "");
            if (rid && REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
              elevenStateMap.set(rid, { cursor: 0, started: false });
            }
          }
          
          if (msg.type === "response.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const outputModalities = msg.response?.output_modalities || [];
            const hasAudioModality = Array.isArray(outputModalities) && outputModalities.includes("audio");
            console.log("✅ response.done reçu:", {
              rid,
              outputModalities,
              hasAudioModality,
              responseKeys: msg.response ? Object.keys(msg.response) : [],
              hasOutputItems: !!msg.response?.output,
              allKeys: Object.keys(msg).slice(0, 20),
            });
            // Log détaillé du status OpenAI pour comprendre les réponses vides
            try {
              const resp = msg.response || {};
              const status = resp.status;
              const statusDetails = resp.status_details || resp.statusDetails || null;
              const usage = resp.usage || null;
              const meta = resp.metadata || null;
              const safeOutputPreview = Array.isArray(resp.output)
                ? resp.output.slice(0, 2) // au cas où, on limite à 2 items
                : resp.output;

              console.log("🔎 Détails response.done OpenAI:", {
                rid,
                status,
                statusDetails,
                usage,
                metadataKeys: meta ? Object.keys(meta).slice(0, 10) : null,
                outputPreviewType: Array.isArray(resp.output) ? `array(${resp.output.length})` : typeof resp.output,
                outputPreview: safeOutputPreview,
              });
            } catch (e) {
              console.error("❌ Erreur lors du log détaillé de response.done:", e);
            }
            if (!hasAudioModality && !REALTIME_USE_ELEVEN) {
              console.error("❌ ERREUR: response.done sans modalité audio et REALTIME_USE_ELEVEN=false - pas d'audio possible !");
            }
            
            // Essayer d'extraire le texte depuis response.output si disponible
            if (REALTIME_USE_ELEVEN && rid && msg.response?.output) {
              const rawOutput = msg.response.output;
              try {
                const extractedText = extractTextFromResponseOutput(rawOutput);
                if (extractedText) {
                  const existingText = transcriptMap.get(rid) || "";
                  if (!existingText.includes(extractedText)) {
                    console.log("📝 Texte extrait depuis response.done:", extractedText.substring(0, 160));
                    if (process.env.OPENAI_OUTPUT_DEBUG === "true") {
                      console.log("📋 DEBUG response.output brut:", JSON.stringify(rawOutput).substring(0, 400));
                    }
                    transcriptMap.set(rid, (existingText + " " + extractedText).trim());
                    if (REALTIME_ELEVEN_CHUNKING_ENABLED) {
                      flushRealtimeElevenChunks(rid, true);
                    } else if (!spokenSet.has(rid)) {
                      spokenSet.add(rid);
                      enqueuePremiumTts(extractedText, { interrupt: false, source: "response.done", responseId: rid });
                    }
                  }
                } else if (msg.response?.output) {
                  // Debug approfondi si aucun texte n'a pu être extrait alors que output existe
                  console.warn("⚠️ Aucun texte extrait depuis response.output malgré hasOutputItems=true");
                  // Toujours logguer la structure brute (tronquée) pour pouvoir ajuster l'extracteur
                  try {
                    console.log(
                      "📋 DEBUG structure response.output:",
                      JSON.stringify(rawOutput, null, 2).substring(0, 1200),
                    );
                  } catch (jsonErr) {
                    console.error("❌ Impossible de sérialiser response.output pour debug:", jsonErr);
                  }
                }
              } catch (e) {
                console.error("❌ Erreur extraction texte depuis response.output:", e);
                if (process.env.OPENAI_OUTPUT_DEBUG === "true") {
                  console.log("📋 DEBUG response.output (erreur extraction):", JSON.stringify(rawOutput).substring(0, 800));
                }
              }
            }

            // NOTE: sur les dernières versions Realtime, le texte est parfois uniquement dans conversation.item.done
            // avec output = []. On gère donc aussi ce cas plus bas.
          }
          if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.audio_transcript.delta") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const delta = msg.delta ?? "";
            if (rid && typeof delta === "string") {
              transcriptMap.set(rid, (transcriptMap.get(rid) || "") + delta);
              // Mode "direct": on commence à parler dès qu'on a assez de texte
              flushRealtimeElevenChunks(rid, false);
            }
          }
          // Gestion des transcripts audio (ancien format)
          if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const doneText = (typeof msg.transcript === "string" ? msg.transcript : "") || (rid ? (transcriptMap.get(rid) || "") : "");
            if (REALTIME_USE_ELEVEN && doneText && doneText.trim()) {
              // Remonter l'IA dans AutoGuru (détails d'appel)
              enqueueIngest("assistant", doneText);
              // Si l'assistant propose d'envoyer un message pour la plaque, envoyer directement sans consentement
              const low = String(doneText || "").toLowerCase();
              // Détecter si l'IA propose d'envoyer un message pour la plaque
              // Chercher des patterns comme "envoyer un message", "envoyer message", "message pour plaque", etc.
              const mentionsPlate = low.includes("plaque") || low.includes("immatric");
              const mentionsMessage = (low.includes("envoyer") && low.includes("message")) || 
                                      (low.includes("message") && (low.includes("plaque") || low.includes("immatric")));
              if (mentionsPlate || mentionsMessage) {
                // Envoyer le SMS directement à la fin de l'appel (pas besoin de consentement)
                plateSmsSendOnFinalize = true;
                console.log("📩 Détection proposition SMS plaque, SMS sera envoyé à la fin de l'appel:", { mentionsPlate, mentionsMessage, textPreview: doneText.substring(0, 100) });
              }
              // Détecter si l'IA dit au revoir
              const goodbyePatterns = [
                "au revoir", "aurevoir", "à bientôt", "a bientot", "bonne journée", "bonne journee",
                "bonne soirée", "bonne soiree", "bonne fin de journée", "bonne fin de journee",
                "excellente journée", "excellente journee", "passez une bonne journée", "passez une bonne journee",
                "merci et au revoir", "merci et bonne journée", "merci et bonne journee"
              ];
              const isGoodbye = goodbyePatterns.some(pattern => low.includes(pattern));
              if (isGoodbye && !goodbyeDetected) {
                goodbyeDetected = true;
                console.log("👋 Détection au revoir de l'IA, hangup automatique dans", GOODBYE_DELAY_MS, "ms");
                // Annuler le timer précédent s'il existe
                if (goodbyeTimer) clearTimeout(goodbyeTimer);
                // Programmer le hangup après un délai
                goodbyeTimer = setTimeout(() => {
                  const timeSinceLastUserActivity = nowMs() - lastUserActivityMs;
                  // Si le client n'a pas parlé depuis au moins 2 secondes, on coupe
                  if (timeSinceLastUserActivity >= 2000) {
                    console.log("📞 Hangup automatique après au revoir (client inactif depuis", timeSinceLastUserActivity, "ms)");
                    triggerHangup("auto_goodbye");
                  } else {
                    console.log("⏸️ Hangup reporté, client actif (dernière activité il y a", timeSinceLastUserActivity, "ms)");
                    // Réessayer dans 2 secondes
                    goodbyeTimer = setTimeout(() => {
                      console.log("📞 Hangup automatique après au revoir (nouvelle tentative)");
                      triggerHangup("auto_goodbye");
                    }, 2000);
                  }
                }, GOODBYE_DELAY_MS);
              }
              // IMPORTANT: Ne pas utiliser de fallback automatique. On attend TOUJOURS une confirmation explicite du client.
              // Le fallback a été supprimé pour éviter d'envoyer des SMS sans consentement clair.
              // Lancer la voix premium.
              // En Realtime+ElevenLabs, on évite les doublons (delta/done multiples).
              if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                // Si chunking actif, on flush le reste et on termine SANS couper l'audio déjà en cours.
                transcriptMap.set(rid, doneText);
                flushRealtimeElevenChunks(rid, true);
              } else if (!rid || !spokenSet.has(rid)) {
                if (rid) spokenSet.add(rid);
                // Ici (sans chunking), on démarre la synthèse en une fois.
                // Ne pas interrompre si on a déjà commencé à parler (évite les coupures)
                const alreadySpeaking = rid && spokenSet.has(rid);
                enqueueElevenLabsTts(doneText, { interrupt: !alreadySpeaking });
              }
            }
          }
          
          // Gestion des messages de conversation (nouveau format Realtime)
          // Ici, OpenAI envoie souvent le texte final dans conversation.item.done plutôt que dans response.output.
          if (msg.type === "conversation.item.done" && msg.item) {
            const item = msg.item;
            try {
              console.log("📨 conversation.item.done reçu:", {
                role: item.role,
                itemId: item.id,
                responseId: msg.response_id ?? null,
                hasContent: !!item.content,
                contentType: Array.isArray(item.content)
                  ? "array(" + item.content.length + ")"
                  : typeof item.content,
                itemKeys: Object.keys(item || {}).slice(0, 10),
              });
            } catch {
              console.log("📨 conversation.item.done reçu (logging simplifié)");
            }
            // On ne s'intéresse qu'aux messages de rôle assistant
            if (item.role !== "assistant") {
              // Si c'est un message user, on marque qu'il a parlé (utile pour ignorer le greeting en double)
              if (item.role === "user") {
                userHasSpoken = true;
              }
            } else {
              // Éviter de rejouer la phrase d'accueil qu'on a déjà synthétisée en local
              if (initialAssistantGreetingText && !userHasSpoken) {
                console.log("👂 Ignorer conversation.item.done pour le greeting (déjà joué via Minimax).");
              } else {
                const rid = msg.response_id ?? null;
                let extracted = "";
                try {
                  // Le texte peut être dans item.content, item.output_text, ou ailleurs
                  if (item.content) {
                    extracted = extractTextFromResponseOutput(item.content);
                  }
                  if (!extracted && typeof item.text === "string") {
                    extracted = item.text;
                  }
                } catch (e) {
                  console.error("❌ Erreur extraction texte depuis conversation.item.done:", e);
                }

                if (extracted && extracted.trim()) {
                  const clean = extracted.trim();
                  console.log("📝 Texte assistant depuis conversation.item.done:", clean.substring(0, 160));
                  // Stocker dans transcriptMap si on a un response_id
                  if (rid) {
                    const existing = transcriptMap.get(rid) || "";
                    transcriptMap.set(rid, (existing + " " + clean).trim());
                  }
                  // Synthèse via TTS premium (Minimax/ElevenLabs)
                  if (REALTIME_USE_ELEVEN) {
                    console.log("🎤 Envoi du texte à enqueuePremiumTts depuis conversation.item.done");
                    enqueuePremiumTts(clean, { interrupt: false, source: "conversation.item.done", responseId: rid });
                  }
                } else {
                  console.warn("⚠️ Aucun texte assistant extrait depuis conversation.item.done");
                  try {
                    console.log(
                      "📋 DEBUG conversation.item (assistant):",
                      JSON.stringify(item, null, 2).substring(0, 1200),
                    );
                  } catch {
                    // ignore
                  }
                }
              }
            }
          }
          
          // Gestion des réponses textuelles en streaming (nouveau format GPT-5: response.output_text.delta)
          if (msg.type === "response.output_text.delta") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const delta = typeof msg.delta === "string" ? msg.delta : "";
            if (rid && delta && delta.trim()) {
              // Accumuler le texte dans le transcript
              const current = transcriptMap.get(rid) || "";
              transcriptMap.set(rid, current + delta);
              // En mode chunking, on peut commencer à parler dès qu'on a assez de texte
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          
          // Gestion des réponses textuelles (nouveau format GPT-5: response.output_text.done)
          if (msg.type === "response.output_text.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            // Récupérer le texte depuis le transcript (accumulé via delta) ou directement depuis msg.text
            const doneText = (rid ? (transcriptMap.get(rid) || "") : "") || (typeof msg.text === "string" ? msg.text : "");
            if (REALTIME_USE_ELEVEN && doneText && doneText.trim()) {
              console.log("📝 Réponse texte IA reçue (GPT-5):", doneText.substring(0, 100));
              // Remonter l'IA dans AutoGuru (détails d'appel)
              enqueueIngest("assistant", doneText);
              // Si l'assistant propose d'envoyer un message pour la plaque, envoyer directement sans consentement
              const low = String(doneText || "").toLowerCase();
              // Détecter si l'IA propose d'envoyer un message pour la plaque
              // Chercher des patterns comme "envoyer un message", "envoyer message", "message pour plaque", etc.
              const mentionsPlate = low.includes("plaque") || low.includes("immatric");
              const mentionsMessage = (low.includes("envoyer") && low.includes("message")) || 
                                      (low.includes("message") && (low.includes("plaque") || low.includes("immatric")));
              if (mentionsPlate || mentionsMessage) {
                // Envoyer le SMS directement à la fin de l'appel (pas besoin de consentement)
                plateSmsSendOnFinalize = true;
                console.log("📩 Détection proposition SMS plaque, SMS sera envoyé à la fin de l'appel:", { mentionsPlate, mentionsMessage, textPreview: doneText.substring(0, 100) });
              }
              // Détecter si l'IA dit au revoir
              const goodbyePatterns = [
                "au revoir", "aurevoir", "à bientôt", "a bientot", "bonne journée", "bonne journee",
                "bonne soirée", "bonne soiree", "bonne fin de journée", "bonne fin de journee",
                "excellente journée", "excellente journee", "passez une bonne journée", "passez une bonne journee",
                "merci et au revoir", "merci et bonne journée", "merci et bonne journee"
              ];
              const isGoodbye = goodbyePatterns.some(pattern => low.includes(pattern));
              if (isGoodbye && !goodbyeDetected) {
                goodbyeDetected = true;
                console.log("👋 Détection au revoir de l'IA, hangup automatique dans", GOODBYE_DELAY_MS, "ms");
                // Annuler le timer précédent s'il existe
                if (goodbyeTimer) clearTimeout(goodbyeTimer);
                // Programmer le hangup après un délai
                goodbyeTimer = setTimeout(() => {
                  const timeSinceLastUserActivity = nowMs() - lastUserActivityMs;
                  // Si le client n'a pas parlé depuis au moins 2 secondes, on coupe
                  if (timeSinceLastUserActivity >= 2000) {
                    console.log("📞 Hangup automatique après au revoir (client inactif depuis", timeSinceLastUserActivity, "ms)");
                    triggerHangup("auto_goodbye");
                  } else {
                    console.log("⏸️ Hangup reporté, client actif (dernière activité il y a", timeSinceLastUserActivity, "ms)");
                    // Réessayer dans 2 secondes
                    goodbyeTimer = setTimeout(() => {
                      console.log("📞 Hangup automatique après au revoir (nouvelle tentative)");
                      triggerHangup("auto_goodbye");
                    }, 2000);
                  }
                }, GOODBYE_DELAY_MS);
              }
              // Lancer la voix premium.
              // En Realtime+ElevenLabs, on évite les doublons (delta/done multiples).
              if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                // Si chunking actif, on flush le reste et on termine SANS couper l'audio déjà en cours.
                transcriptMap.set(rid, doneText);
                flushRealtimeElevenChunks(rid, true);
              } else if (!rid || !spokenSet.has(rid)) {
                if (rid) spokenSet.add(rid);
                // Ici (sans chunking), on démarre la synthèse en une fois.
                // Ne pas interrompre si on a déjà commencé à parler (évite les coupures)
                const alreadySpeaking = rid && spokenSet.has(rid);
                enqueuePremiumTts(doneText, { interrupt: !alreadySpeaking, source: "response.output_text.done", responseId: rid });
              }
            }
          }
          
          // Gestion des content_part (nouveau format GPT-5: accumulation du texte)
          if (msg.type === "response.content_part.added") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const part = msg.part;
            // Le texte peut être dans part.text ou directement dans part
            const text = (part && typeof part.text === "string" ? part.text : null) || 
                        (part && typeof part === "string" ? part : null) ||
                        (typeof msg.text === "string" ? msg.text : null);
            if (rid && text && text.trim()) {
              // Accumuler le texte dans le transcript
              const current = transcriptMap.get(rid) || "";
              transcriptMap.set(rid, current + text);
              // En mode chunking, on peut commencer à parler dès qu'on a assez de texte
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          
          // Gestion de response.content_part.done (fin d'un chunk de texte)
          if (msg.type === "response.content_part.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const part = msg.part;
            // Le texte peut être dans part.text ou directement dans part
            const text = (part && typeof part.text === "string" ? part.text : null) || 
                        (part && typeof part === "string" ? part : null) ||
                        (typeof msg.text === "string" ? msg.text : null);
            if (rid && text && text.trim()) {
              // S'assurer que le texte est dans le transcript
              const current = transcriptMap.get(rid) || "";
              if (!current.includes(text)) {
                transcriptMap.set(rid, current + text);
              }
              // En mode chunking, on peut continuer à parler
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          
          // IMPORTANT: selon les versions, le delta audio peut arriver sous:
          // - response.audio.delta
          // - response.output_audio.delta
          if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
            console.log("🎵 Delta audio reçu:", {
              type: msg.type,
              hasDelta: !!msg.delta,
              hasAudio: !!msg.audio,
              hasChunk: !!msg.chunk,
              keys: Object.keys(msg).slice(0, 10),
            });
            // Si on utilise ElevenLabs en Realtime, on ignore complètement l'audio OpenAI (sinon doublon + backlog).
            // SAUF si ElevenLabs est en erreur (bypass) → on repasse sur OpenAI pour éviter le silence total.
            // premiumTtsBypassUntilMs > nowMs() signifie que le bypass est actif (ElevenLabs en erreur)
            // Si ElevenLabs fonctionne (pas en bypass), on ignore l'audio OpenAI
            if (REALTIME_USE_ELEVEN && nowMs() >= premiumTtsBypassUntilMs) {
              // ElevenLabs actif (pas en bypass), on ignore l'audio OpenAI
              return;
            }
            // Si on arrive ici, soit REALTIME_USE_ELEVEN est false, soit le bypass est actif (ElevenLabs en erreur)
            // Fallback actif : on utilise l'audio OpenAI (moins naturel mais fonctionne)
            if (REALTIME_USE_ELEVEN && nowMs() < premiumTtsBypassUntilMs) {
              const remainingMinutes = Math.ceil((premiumTtsBypassUntilMs - nowMs()) / 60000);
              if (!ws.__loggedFallbackAudio) {
                ws.__loggedFallbackAudio = true;
                console.warn("⚠️ FALLBACK ACTIF: Utilisation audio OpenAI au lieu d'ElevenLabs (reste ~" + remainingMinutes + " min).");
                if (premiumTtsLastError) {
                  console.error("   Dernière erreur ElevenLabs:", premiumTtsLastError);
                }
              }
            }
            const audioBase64 =
              msg.delta ??
              msg.audio ??
              msg.chunk ??
              msg?.output_audio?.delta ??
              null;
            
            try {
              if (!audioBase64) {
                console.log("⚠️ Delta audio reçu sans champ utilisable:", {
                  type: msg.type,
                  keys: Object.keys(msg),
                });
                return;
              }

              // OpenAI sort en PCM16 24kHz → convertir en μ-law 8kHz pour Twilio
              const pcm24kBuffer = Buffer.from(audioBase64, "base64");
              const pcm24k = new Int16Array(
                pcm24kBuffer.buffer,
                pcm24kBuffer.byteOffset,
                pcm24kBuffer.length / 2,
              );
              const mulaw = convertPcm24kToMulaw(pcm24k);
              const mulawBuf = Buffer.from(mulaw);
              enqueueOutboundMulaw(mulawBuf);

              if (!loggedFirstAudioDelta) {
                loggedFirstAudioDelta = true;
                console.log("🔈 Premier delta audio OpenAI -> Twilio:", {
                  pcmBytes: pcm24kBuffer.length,
                  pcmSamples: pcm24k.length,
                  mulawBytes: mulawBuf.length,
                  outboundQueuedBytes,
                });
              }
              
              if (Math.random() < 0.01) {
                console.log("🔊 Audio réponse converti (enqueue) :", {
                  streamSid: twilioStreamSid,
                  deltaLength: audioBase64.length,
                  format: "pcm16->mulaw",
                  outboundQueuedBytes,
                });
              }
            } catch (err) {
              console.error("❌ Erreur conversion/envoi audio à Twilio:", err);
            }
          }
          
          if (msg.type === "response.audio_transcript.done" || msg.type === "response.output_audio_transcript.done") {
            console.log("📝 Transcription IA:", msg.transcript);
          }
          
          if (msg.type === "response.output_item.added" || msg.type === "response.output_item.done") {
            console.log("✅ Réponse IA:", msg.type, msg.item?.type);
            // Log détaillé pour diagnostiquer l'absence d'audio
            if (msg.item) {
              console.log("📋 Détails item réponse:", {
                type: msg.item.type,
                hasContent: !!msg.item.content,
                contentTypes: msg.item.content ? msg.item.content.map((c) => c?.type).filter(Boolean) : [],
                keys: Object.keys(msg.item),
              });
              
              // Extraire le texte depuis msg.item.content pour le passer au TTS
              if (msg.item.content && Array.isArray(msg.item.content)) {
                const rid = msg.response_id ?? msg.response?.id ?? null;
                let extractedText = "";
                for (const content of msg.item.content) {
                  if (content.type === "text" && typeof content.text === "string") {
                    extractedText += content.text;
                  } else if (typeof content === "string") {
                    extractedText += content;
                  }
                }
                if (extractedText.trim() && REALTIME_USE_ELEVEN) {
                  console.log("📝 Texte extrait depuis output_item:", extractedText.substring(0, 100));
                  // S'assurer que le texte est dans le transcript
                  if (rid) {
                    transcriptMap.set(rid, extractedText);
                  }
                  // Lancer la synthèse TTS
                  if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                    flushRealtimeElevenChunks(rid, msg.type === "response.output_item.done");
                  } else if (!rid || !spokenSet.has(rid)) {
                    if (rid) spokenSet.add(rid);
                    enqueuePremiumTts(extractedText, { interrupt: msg.type === "response.output_item.done", source: msg.type, responseId: rid });
                  }
                }
              }
            }
          }
          
          // Log tous les types de messages pour debug audio
          if (msg.type && (msg.type.includes("audio") || msg.type.includes("output"))) {
            console.log("🔊 Message audio/output:", msg.type, {
              hasDelta: !!msg.delta,
              hasAudio: !!msg.audio,
              hasChunk: !!msg.chunk,
              keys: Object.keys(msg).slice(0, 10),
            });
          }
          
          if (msg.type === "conversation.item.input_audio_transcription.completed") {
            const transcript = msg.transcript;
            console.log("🎤 Client dit:", transcript);
            enqueueIngest("user", transcript);
          }
          
          if (msg.type === "error") {
            console.error("❌ Erreur OpenAI:", msg.error);
            // Auto-fix: si un param de session n'est pas supporté, on renvoie une session.update minimale
            // pour éviter un comportement "bizarre" (instructions partiellement appliquées).
            const errParam = String(msg?.error?.param ?? "");
            const errCode = String(msg?.error?.code ?? "");
            if (errCode === "unknown_parameter" && errParam.startsWith("session.")) {
              if (!ws.__didSessionFallback) {
                ws.__didSessionFallback = true;
                console.warn("↩️ Fallback session.update (minimal) après unknown_parameter:", { errParam });
                try {
                  // Ne renvoyer que les instructions (déjà calculées et stockées côté ws)
                  const instr = String(ws.__sessionInstructions || "");
                  if (instr && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.send(JSON.stringify({
                      type: "session.update",
                      session: { type: "realtime", instructions: instr },
                    }));
                  }
                } catch (e) {
                  console.error("❌ Fallback session.update échoué:", e);
                }
              }
            }
          }

          // NOTE: On garde ces events si jamais ils arrivent, mais on ne dépend pas d'eux.
          // IMPORTANT: Filtrer les faux positifs d'OpenAI (détection trop sensible au bruit)
          if (msg.type === "input_audio_buffer.speech_started") {
            // Vérifier que le niveau audio local confirme vraiment de la parole
            // Si le niveau audio récent est trop faible, c'est probablement un faux positif
            const shouldIgnore = INPUT_GATE_ENABLED && lastInputAudioLevel < INPUT_SPEECH_THRESHOLD;
            if (shouldIgnore) {
              console.log("🔇 Ignoré speech_started OpenAI (faux positif, niveau audio trop faible:", lastInputAudioLevel, "<", INPUT_SPEECH_THRESHOLD + ")");
              return;
            }
            speechActive = true;
            lastSpeechTs = nowMs();
            awaitingUserResponse = true;
            bytesSinceSpeechStart = 0;
            userHasSpoken = true;
            // NOTE: ne pas annuler la réponse sur ce signal, il peut être trop sensible (bruit / écho).
            // Le barge-in est géré côté Twilio via VAD local sur les frames inbound.
          }
          if (msg.type === "input_audio_buffer.speech_stopped") {
            speechActive = false;
            // IMPORTANT:
            // Ne PAS envoyer input_audio_buffer.commit côté client : OpenAI fait déjà l'auto-commit via son VAD
            // (sinon on déclenche commit_empty en boucle).
          }

          if (msg.type === "input_audio_buffer.committed") {
            appendedBytes = 0;
            lastCommittedAt = nowMs();
            console.log("✅ OpenAI buffer committed:", {
              item_id: msg.item_id,
              previous_item_id: msg.previous_item_id,
            });
            // Ne pas forcer response.create tout de suite: OpenAI peut auto-démarrer une réponse.
            // On met un watchdog: si aucune réponse ne démarre après le commit, on envoie response.create.
            const canRequest = (lastCommittedAt - lastResponseAt) > 600;
            if (awaitingUserResponse && canRequest) {
              lastResponseAt = lastCommittedAt;
              awaitingUserResponse = false;
              setTimeout(() => {
                // Si OpenAI n'a pas démarré de réponse depuis ce commit, on déclenche.
                if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
                if (responseInProgress) return;
                if (lastResponseCreatedAt >= lastCommittedAt) return;
                requestResponseCreate("watchdog_after_commit");
              }, WATCHDOG_AFTER_COMMIT_MS);
            }
          }

          if (msg.type === "response.created") {
            responseInProgress = true;
            activeResponseId = msg.response?.id ?? msg.response_id ?? null;
            lastResponseCreatedAt = nowMs();
            // Timeout de sécurité : si la réponse ne se termine pas dans 30s, on réinitialise
            // (évite que responseInProgress reste bloqué à true si l'IA ne répond pas)
            setTimeout(() => {
              if (responseInProgress && activeResponseId === (msg.response?.id ?? msg.response_id ?? null)) {
                console.warn("⚠️ Timeout réponse IA: réinitialisation responseInProgress après 30s");
                responseInProgress = false;
                activeResponseId = null;
              }
            }, 30000);
          }

          if (msg.type === "response.done") {
            responseInProgress = false;
            activeResponseId = null;
          }
          
          if (msg.type === "session.created" || msg.type === "session.updated") {
            console.log("✅ Session OpenAI configurée");
          }
        } catch (err) {
          console.error("❌ Erreur parsing OpenAI message:", err, data.toString().substring(0, 100));
        }
      });

      openaiWs.on("error", (err) => {
        clearTimeout(connectionTimeout);
        console.error("❌ Erreur OpenAI WS:", err);
        console.error("❌ OpenAI WS error details:", {
          message: err.message,
          code: err.code,
          stack: err.stack?.substring(0, 500),
        });
        // Si erreur de connexion, essayer de reconnecter après un délai
        if (err.message && (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT") || err.message.includes("ENOTFOUND"))) {
          console.warn("⚠️ Erreur réseau OpenAI, tentative de reconnexion dans 2s...");
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN && (!openaiWs || openaiWs.readyState !== WebSocket.OPEN)) {
              console.log("🔄 Tentative de reconnexion OpenAI...");
              connectToOpenAI();
            }
          }, 2000);
        }
      });

      openaiWs.on("close", (code, reason) => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        console.log("🔌 OpenAI WS fermé", { code, reason: reason?.toString() });
        if (code !== 1000) {
          console.warn("⚠️ OpenAI WS fermé anormalement (code != 1000)");
          // Si fermeture avant connexion (code 1006 = connexion fermée sans handshake)
          if (code === 1006) {
            console.error("❌ Connexion OpenAI fermée avant établissement (code 1006)");
            console.error("❌ Vérifiez OPENAI_API_KEY et la connectivité réseau");
          }
        }
      });
    } catch (err) {
      console.error("❌ Erreur connexion OpenAI:", err);
      console.error("❌ Erreur détails:", {
        message: err.message,
        code: err.code,
        stack: err.stack?.substring(0, 500),
      });
    }
  }

  ws.on("message", (data) => {
    // Twilio Media Streams sends JSON frames: start, media, stop
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.event === "start") {
        const streamCallSid = msg.start?.callSid;
        twilioStreamSid = msg.start?.streamSid ?? null;
        
        // Extraire les paramètres depuis start.customParameters (passés via TwiML parameters)
        const startParams = msg.start?.customParameters || {};
        const finalCallSid = startParams.callSid || callSid || streamCallSid;
        const finalGarageId = startParams.garageId || garageId;
        const finalGarageName = startParams.garageName || garageName;
        const finalFromNumber = startParams.fromNumber || fromNumber;
        // AutoGuru ingest (Option A): transmis par AutoGuru via Twilio <Parameter>
        const finalIngestUrl = startParams.autoguruIngestUrl || "";
        const finalIngestToken = startParams.autoguruIngestToken || "";
        const finalAssistantName = startParams.assistantName || "";
        const finalAssistantVoice = startParams.assistantVoice || "";
        const finalGarageTone = startParams.garageTone || "";
        const finalConsentRequired = startParams.consentRequired || "";
        const finalAppointmentMode = startParams.appointmentMode || "";
        const finalGarageClosed = startParams.garageClosed || "";
        const finalGarageClosedReason = startParams.garageClosedReason || "";
        const finalGarageClosedText = startParams.garageClosedText || "";
        const finalGarageHoursText =
          startParams.garageHoursText ||
          startParams.openingHours ||
          startParams.hoursText ||
          "";
        const finalCollectVehicleInfo = startParams.collectVehicleInfo || "";
        const finalPricingSummary = startParams.pricingSummary || "";
        const finalServicesSummary = startParams.servicesSummary || "";
        const finalFaqsSummary = startParams.faqsSummary || "";
        
        console.log("🎬 Stream start:", {
          streamCallSid,
          streamSid: twilioStreamSid,
          callSid: finalCallSid,
          garageId: finalGarageId,
          garageName: finalGarageName,
          fromNumber: finalFromNumber,
          garageClosed: finalGarageClosed,
          garageClosedReason: finalGarageClosedReason,
          collectVehicleInfo: finalCollectVehicleInfo,
          hasPricingSummary: Boolean(finalPricingSummary && String(finalPricingSummary).trim()),
          customParameters: startParams,
          mediaFormat: msg.start?.mediaFormat
        });
        
        // Mettre à jour les variables pour utiliser dans OpenAI
        callSid = finalCallSid;
        garageId = finalGarageId;
        garageName = finalGarageName;
        fromNumber = finalFromNumber;
        if (typeof finalIngestUrl === "string" && finalIngestUrl.trim()) autoguruIngestUrl = finalIngestUrl.trim();
        if (typeof finalIngestToken === "string" && finalIngestToken.trim()) autoguruIngestToken = finalIngestToken.trim();
        if (typeof finalAssistantName === "string" && finalAssistantName.trim()) assistantName = finalAssistantName.trim();
        if (typeof finalAssistantVoice === "string" && finalAssistantVoice.trim()) assistantVoice = finalAssistantVoice.trim().toLowerCase();
        if (typeof finalGarageTone === "string") garageTone = finalGarageTone.trim();
        if (typeof finalConsentRequired === "string" && finalConsentRequired.trim()) consentRequired = finalConsentRequired.trim().toLowerCase() === "true";
        if (typeof finalAppointmentMode === "string" && finalAppointmentMode.trim()) appointmentMode = finalAppointmentMode.trim();
        if (typeof finalGarageClosed === "string" && finalGarageClosed.trim()) garageClosed = finalGarageClosed.trim().toLowerCase() === "true";
        if (typeof finalGarageClosedReason === "string") garageClosedReason = String(finalGarageClosedReason || "").trim();
        if (typeof finalGarageClosedText === "string") garageClosedText = String(finalGarageClosedText || "").trim();
        if (typeof finalGarageHoursText === "string") garageHoursText = String(finalGarageHoursText || "").trim();
        if (typeof finalClosedDaysText === "string") closedDaysText = String(finalClosedDaysText || "").trim();
        if (typeof finalCollectVehicleInfo === "string" && finalCollectVehicleInfo.trim()) collectVehicleInfo = finalCollectVehicleInfo.trim().toLowerCase() === "true";
        if (typeof finalPricingSummary === "string") pricingSummary = String(finalPricingSummary || "").trim();
        if (typeof finalServicesSummary === "string") servicesSummary = String(finalServicesSummary || "").trim();
        if (typeof finalFaqsSummary === "string") faqsSummary = String(finalFaqsSummary || "").trim();

        // Récupérer les infos client (nom, rendez-vous) pour l'IA
        // IMPORTANT: faire cette requête de manière asynchrone, ne pas bloquer le démarrage du stream
        (async () => {
          try {
            console.log("🔍 Tentative récupération infos client:", {
              garageId: finalGarageId,
              fromNumber: finalFromNumber,
              hasSecret: !!AUTOGURU_INGEST_SECRET_ENV,
              hasIngestUrl: !!autoguruIngestUrl,
            });
            
            // Utiliser le token pour authentifier si AUTOGURU_INGEST_SECRET_ENV n'est pas défini
            // L'API accepte soit x-secret (REALTIME_INGEST_SECRET) soit le token dans les query params
            const secretToUse = AUTOGURU_INGEST_SECRET_ENV || "";
            const tokenToUse = autoguruIngestToken || "";
            
            if (finalGarageId && finalFromNumber && autoguruIngestUrl) {
              // Construire l'URL de l'API client-info à partir de autoguruIngestUrl
              const baseUrl = autoguruIngestUrl.replace(/\/api\/twilio\/realtime-ingest.*$/, "");
              let clientInfoUrl = `${baseUrl}/api/twilio/client-info?garageId=${encodeURIComponent(finalGarageId)}&phoneNumber=${encodeURIComponent(finalFromNumber)}`;
              
              // Si on a un token mais pas de secret, passer le token dans l'URL
              if (!secretToUse && tokenToUse) {
                clientInfoUrl += `&token=${encodeURIComponent(tokenToUse)}`;
              } else if (!secretToUse && !tokenToUse) {
                // Si ni secret ni token, on ne peut pas appeler l'API
                console.warn("⚠️ Pas de secret ni token pour client-info, skip");
                return;
              }
              
              console.log("🔍 Appel API client-info:", clientInfoUrl.replace(/secret=\S+|token=\S+/, "***"));
              
              const headers = {};
              if (secretToUse) {
                headers["x-secret"] = secretToUse;
              }
              
              const response = await fetch(clientInfoUrl, {
                method: "GET",
                headers,
              });
              
              console.log("🔍 Réponse API client-info:", {
                status: response.status,
                ok: response.ok,
              });
              
              if (response.ok) {
                const data = await response.json();
                console.log("🔍 Données reçues:", {
                  hasClient: !!data.client,
                  clientName: data.client?.name || "N/A",
                  clientPlate: data.client?.plate || "Aucune plaque",
                });
                
                if (data.client) {
                  clientInfo = data.client;
                  console.log("✅ Infos client récupérées:", {
                    name: clientInfo.name,
                    firstName: clientInfo.first_name || "N/A",
                    gender: clientInfo.gender || "N/A",
                    plate: clientInfo.plate || "Aucune plaque",
                    appointmentsCount: clientInfo.appointments?.length || 0,
                  });
                  
                  // Mettre à jour le prompt si OpenAI est déjà connecté
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    if (ws.__updatePromptWithClientInfo) {
                      console.log("🔄 Mise à jour du prompt avec les infos client (incluant plaque)");
                      ws.__updatePromptWithClientInfo();
                    } else {
                      console.warn("⚠️ Fonction updatePromptWithClientInfo non disponible");
                    }
                  } else {
                    console.warn("⚠️ OpenAI pas connecté (état:", openaiWs?.readyState, ")");
                  }
                  
                  // Jouer le greeting avec le nom du client APRÈS avoir chargé les infos
                  const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
                  const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
                  if (!hasGreetedRecently(callSid) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN && !initialAssistantGreetingText) {
                    const rawName = String(garageName || "AutoGuru").trim();
                    const label = /^garage\b/i.test(rawName) ? rawName : `Garage ${rawName}`;
                    // Utiliser uniquement le nom de famille (last_name), pas le nom complet
                    let lastName = clientInfo.last_name ? String(clientInfo.last_name).trim() : null;
                    // Si pas de last_name, extraire le dernier mot du nom complet comme fallback
                    if (!lastName || lastName === "") {
                      if (clientInfo.name) {
                        const nameParts = clientInfo.name.split(/\s+/).filter(p => p.trim().length > 0);
                        lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : (nameParts.length === 1 ? nameParts[0] : clientInfo.name);
                      }
                    }
                    const gender = clientInfo.gender ? String(clientInfo.gender).trim() : null;
                    const title = gender === "homme" ? "Monsieur" : gender === "femme" ? "Madame" : null;
                    // Construire salutationName avec le nom de famille ou le nom complet en fallback
                    let salutationName = "";
                    if (lastName && lastName.trim().length > 0) {
                      salutationName = title ? `${title} ${lastName}` : lastName;
                    } else if (clientInfo.name) {
                      salutationName = title ? `${title} ${clientInfo.name}` : clientInfo.name;
                    }
                    const baseHello = `Bonjour ${salutationName} ! Ici ${assistantName}, l'assistante du ${label}.`;
                    const consentText = consentRequired
                      ? "Cet appel est enregistré pour organiser au mieux votre prise en charge. Si vous refusez, vous pouvez raccrocher."
                      : "";
                    const question = consentRequired
                      ? "Est-ce que cela vous convient ?"
                      : "Dites-moi, quel est le souci avec votre véhicule ?";
                    const greeting = [baseHello, consentText, question].filter(Boolean).join(" ");
                    initialAssistantGreetingText = greeting;
                    enqueuePremiumTts(greeting, { interrupt: true, source: "initial_greeting", allowWithoutUser: true });
                    const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
                    console.log(`👋 Greeting avec nom client joué via ${providerName}.`, { callSid, consentRequired, salutationName, lastName, clientName: clientInfo.name });
                    if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
                  }
                } else {
                  console.log("ℹ️ Aucun client trouvé pour ce numéro");
                }
              } else {
                const errorText = await response.text().catch(() => "");
                console.log("ℹ️ Client non trouvé ou erreur récupération infos client:", {
                  status: response.status,
                  error: errorText.substring(0, 200),
                });
              }
            } else {
              console.warn("⚠️ Paramètres manquants pour récupération infos client:", {
                hasGarageId: !!finalGarageId,
                hasFromNumber: !!finalFromNumber,
                hasSecret: !!AUTOGURU_INGEST_SECRET_ENV,
                hasIngestUrl: !!autoguruIngestUrl,
              });
            }
          } catch (e) {
            console.error("❌ Erreur récupération infos client:", e);
            console.error("❌ Stack:", e.stack?.substring(0, 500));
          }
        })();

        // Toujours logguer la config au démarrage d'un stream pour diagnostiquer Render env vs code path.
        logPipelineConfigOnce("⚙️ Pipeline actif");

        // 🔥 Greeting immédiat (ultra-réactif) :
        // - doit annoncer l'enregistrement AVANT que le client puisse répondre
        // - doit utiliser la voix TTS premium (Minimax/ElevenLabs, pas attendre OpenAI)
        // - on injecte ensuite le même texte dans la conversation OpenAI pour éviter les répétitions
        // - ATTENTION: si clientInfo est disponible, le greeting sera joué APRÈS son chargement (dans le callback client-info)
        //   sinon, on joue un greeting générique après un court délai
        try {
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          if ((!greetOncePerCall || !hasGreetedRecently(callSid)) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN) {
            // Fallback: si clientInfo n'est pas chargé après 500ms, jouer un greeting générique
            setTimeout(() => {
              // Si on a déjà joué un greeting avec le nom du client, ne pas en jouer un autre
              if (initialAssistantGreetingText) return;
              
              const rawName = String(garageName || "AutoGuru").trim();
              const label = /^garage\b/i.test(rawName) ? rawName : `Garage ${rawName}`;
              const baseHello = `Bonjour, ici ${assistantName}, l'assistante du ${label}.`;
              const consentText = consentRequired
                ? "Cet appel est enregistré pour organiser au mieux votre prise en charge. Si vous refusez, vous pouvez raccrocher."
                : "";
              const question = consentRequired
                ? "Est-ce que cela vous convient ?"
                : "Dites-moi, quel est le souci avec votre véhicule ?";
              const greeting = [baseHello, consentText, question].filter(Boolean).join(" ");
              initialAssistantGreetingText = greeting;
              enqueuePremiumTts(greeting, { interrupt: true, source: "initial_greeting", allowWithoutUser: true });
              const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
              console.log(`👋 Greeting générique (sans nom client) joué via ${providerName}.`, { callSid, consentRequired });
              if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
            }, 500); // Délai augmenté : si clientInfo n'est pas chargé après 500ms, jouer greeting générique
          }
        } catch (e) {
          const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
          console.error(`❌ Erreur greeting immédiat ${providerName}:`, e);
        }
        
        // Démarrage selon mode pipeline
        if (PIPELINE_MODE === "stt_llm_tts") {
          // Greeting direct via TTS premium (évite le Realtime)
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          if (!greetOncePerCall || !hasGreetedRecently(callSid)) {
            const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "150");
            setTimeout(() => {
              const rawName = String(garageName || "AutoGuru").trim();
              const label = /^garage\b/i.test(rawName) ? rawName : `Garage ${rawName}`;
              const variations = [
                `Oui allô, bonjour ! Ici ${label}. Je vous écoute. Qu'est-ce qui vous amène ?`,
                `Bonjour ! ${label}. Dites-moi, c'est quoi le souci sur la voiture ?`,
                `Oui bonjour, ${label}. Je vous écoute, qu'est-ce qui se passe ?`,
                `Bonjour, vous êtes bien chez ${label}. Je vous écoute.`,
              ];
              const greeting = variations[Math.floor(Math.random() * variations.length)];
              enqueueElevenLabsTts(
                greeting,
                { interrupt: true },
              );
              if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
            }, greetingDelayMs);
          }
        } else {
          // Connecter à OpenAI Realtime (mode historique)
          connectToOpenAI();
        }

        // Timer d'envoi audio sortant vers Twilio (20ms).
        // IMPORTANT: si OpenAI génère l'audio en rafales, le backlog grimpe vite et l'appelant croit que "ça ne répond plus".
        // On draine plus vite dès ~2–3 secondes de retard pour garder une latence acceptable.
        if (!outboundTimer) {
          outboundTimer = setInterval(() => {
            try {
              // Pacing 20ms, avec drainage adaptatif en cas de backlog
              // (Twilio tolère qu'on envoie un peu plus vite, ça réduit la latence sans drop).
              const backlogFrames = Math.floor(outboundQueuedBytes / 160);
              const framesToSend =
                backlogFrames > 800 ? 4 : // >16s
                backlogFrames > 300 ? 3 : // >6s
                backlogFrames > 120 ? 2 : // >2.4s
                1;
              sendOutboundFrames(framesToSend);
            } catch {
              // ignore
            }
          }, 20);
        }
        
      } else if (msg.event === "media") {
        mediaCount += 1;
        if (mediaCount === 1) {
          console.log("🎤 Premier frame audio reçu:", {
            track: msg.media?.track,
            chunk: msg.media?.chunk,
            timestamp: msg.media?.timestamp,
            payloadLength: msg.media?.payload?.length
          });
        }
        if (mediaCount % 200 === 0) {
          console.log(`📊 Media frames: ${mediaCount}`);
        }
        
        // Mode Option B: VAD local → buffer → STT→LLM→TTS
        if (PIPELINE_MODE === "stt_llm_tts") {
          const audioBase64 = msg.media?.payload;
          if (!audioBase64) return;
          const mulawBuffer = Buffer.from(audioBase64, "base64");

          // Ne pas capturer pendant que l'assistant parle (anti-écho/TV)
          // Même logique que pour realtime : ne bloquer que si vraiment nécessaire
          const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
          const assistantIsReallyTalking = 
            responseInProgress || 
            (assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES && premiumTtsInFlight);
          if (INPUT_SUPPRESS_WHILE_TALKING && assistantIsReallyTalking) return;

          const avg = avgAbsMulaw(mulawBuffer);
          const isSpeech = avg > STT_SPEECH_THRESHOLD;
          const isSilence = avg < STT_SILENCE_THRESHOLD;

          if (isSpeech) {
            sttSpeechFrames += 1;
            sttSilenceFrames = 0;
          } else if (isSilence) {
            sttSilenceFrames += 1;
            sttSpeechFrames = Math.max(0, sttSpeechFrames - 1);
          } else {
            sttSpeechFrames = Math.max(0, sttSpeechFrames - 1);
            sttSilenceFrames = Math.max(0, sttSilenceFrames - 1);
          }

          if (!sttActive && sttSpeechFrames >= STT_SPEECH_FRAMES) {
            sttActive = true;
            sttStartedAt = nowMs();
            sttMulawChunks = [];
            sttBytes = 0;
          }

          if (sttActive) {
            sttMulawChunks.push(mulawBuffer);
            sttBytes += mulawBuffer.length;
          }

          // Fin de phrase: silence stable
          // End-of-utterance adaptatif:
          // - phrases longues → on déclenche plus vite (latence)
          // - phrases courtes → on attend un peu plus (évite de couper)
          const utterMs = sttActive ? (nowMs() - sttStartedAt) : 0;
          let requiredSilenceFrames = STT_SILENCE_FRAMES;
          if (utterMs >= 2500) requiredSilenceFrames = Math.max(10, Math.floor(STT_SILENCE_FRAMES * 0.65));
          else if (utterMs >= 1500) requiredSilenceFrames = Math.max(12, Math.floor(STT_SILENCE_FRAMES * 0.8));

          if (sttActive && sttSilenceFrames >= requiredSilenceFrames) {
            const durMs = nowMs() - sttStartedAt;
            sttActive = false;
            sttSpeechFrames = 0;
            sttSilenceFrames = 0;
            if (durMs >= STT_MIN_AUDIO_MS) {
              // Backchannel intelligent (moins souvent + seulement si la réponse tarde)
              if (BACKCHANNEL_ENABLED && PREMIUM_TTS_ENABLED && !sttInFlight) {
                const now = nowMs();
                const canPlay = (now - lastBackchannelAt) >= BACKCHANNEL_MIN_INTERVAL_MS;
                if (canPlay) {
                  if (backchannelTimer) clearTimeout(backchannelTimer);
                  backchannelTimer = setTimeout(() => {
                    // Si une réponse est déjà en cours (TTS), ne pas rajouter un "ok je note"
                    if (premiumTtsInFlight) return;
                    lastBackchannelAt = nowMs();
                    console.log("🗣️ Backchannel:", { text: BACKCHANNEL_TEXT });
                    enqueueElevenLabsTts(BACKCHANNEL_TEXT, { interrupt: true });
                  }, BACKCHANNEL_DELAY_MS);
                }
              }
              runSttLlmTtsTurn();
            } else {
              sttMulawChunks = [];
              sttBytes = 0;
            }
          }
          return;
        }

        // VAD local "output": détecter si le client parle pour retarder la réponse (realtime + elevenlabs)
        try {
          const audioBase64ForVad = msg.media?.payload;
          if (audioBase64ForVad) {
            const mulawForVad = Buffer.from(audioBase64ForVad, "base64");
            const avg = avgAbsMulaw(mulawForVad);
            const isSpeech = avg > OUTPUT_USER_SPEECH_THRESHOLD;
            const isSilence = avg < OUTPUT_USER_SILENCE_THRESHOLD;

            if (isSpeech) {
              outUserSpeechFrames += 1;
              outUserSilenceFrames = 0;
            } else if (isSilence) {
              outUserSilenceFrames += 1;
              outUserSpeechFrames = Math.max(0, outUserSpeechFrames - 1);
            } else {
              outUserSpeechFrames = Math.max(0, outUserSpeechFrames - 1);
              outUserSilenceFrames = Math.max(0, outUserSilenceFrames - 1);
            }

            if (!outUserSpeaking && outUserSpeechFrames >= OUTPUT_USER_SPEECH_FRAMES) {
              outUserSpeaking = true;
            }
            if (outUserSpeaking && outUserSilenceFrames >= OUTPUT_USER_SILENCE_FRAMES) {
              outUserSpeaking = false;
              // Dès que le client se tait, on vide la file d'attente ElevenLabs (sans couper l'audio si déjà en cours).
              if (pendingSpeakQueue.length > 0) {
                const toSpeak = pendingSpeakQueue.join(" ");
                pendingSpeakQueue = [];
                enqueueElevenLabsTts(toSpeak, { interrupt: false });
              }
            }
          }
        } catch {
          // ignore
        }

        // Realtime STT local (Whisper) -> AutoGuru details (utile quand OpenAI input_audio_transcription n'est pas supporté)
        try {
          if (PIPELINE_MODE === "realtime" && REALTIME_USER_STT_ENABLED && !rtSttInFlight) {
            const audioBase64Stt = msg.media?.payload;
            if (audioBase64Stt) {
              const mulawBuf = Buffer.from(audioBase64Stt, "base64");
              const avg = avgAbsMulaw(mulawBuf);
              const isSpeech = avg > REALTIME_USER_STT_SPEECH_THRESHOLD;
              const isSilence = avg < REALTIME_USER_STT_SILENCE_THRESHOLD;

              if (isSpeech) {
                rtSttSpeechFrames += 1;
                rtSttSilenceFrames = 0;
              } else if (isSilence) {
                rtSttSilenceFrames += 1;
                rtSttSpeechFrames = Math.max(0, rtSttSpeechFrames - 1);
              } else {
                rtSttSpeechFrames = Math.max(0, rtSttSpeechFrames - 1);
                rtSttSilenceFrames = Math.max(0, rtSttSilenceFrames - 1);
              }

              if (!rtSttActive && rtSttSpeechFrames >= REALTIME_USER_STT_SPEECH_FRAMES) {
                rtSttActive = true;
                rtSttStartedAt = nowMs();
                rtSttMulawChunks = [];
              }

              if (rtSttActive) {
                rtSttMulawChunks.push(mulawBuf);
              }

              if (rtSttActive && rtSttSilenceFrames >= REALTIME_USER_STT_SILENCE_FRAMES) {
                const durMs = nowMs() - rtSttStartedAt;
                rtSttActive = false;
                rtSttSpeechFrames = 0;
                rtSttSilenceFrames = 0;

                if (durMs >= REALTIME_USER_STT_MIN_AUDIO_MS) {
                  const joined = rtSttMulawChunks.length ? Buffer.concat(rtSttMulawChunks) : Buffer.alloc(0);
                  rtSttMulawChunks = [];
                  rtSttInFlight = true;
                  (async () => {
                    try {
                      const wav = mulaw8kToPcm16kWav(joined);
                      const txt = (await openaiTranscribeWav(wav)).trim();
                      if (txt && !isJunkTranscript(txt)) {
                        enqueueIngest("user", txt);
                        // (Consentement SMS plaque supprimé: envoi automatique à la fin de l'appel)
                        // Mettre à jour la dernière activité utilisateur
                        lastUserActivityMs = nowMs();
                        // Si l'utilisateur parle après un au revoir, annuler le hangup automatique
                        if (goodbyeDetected) {
                          console.log("🔄 Client a parlé après au revoir, annulation du hangup automatique");
                          goodbyeDetected = false;
                          if (goodbyeTimer) {
                            clearTimeout(goodbyeTimer);
                            goodbyeTimer = null;
                          }
                        }
                      }
                    } catch {
                      // ignore
                    } finally {
                      rtSttInFlight = false;
                    }
                  })();
                } else {
                  rtSttMulawChunks = [];
                }
              }
            }
          }
        } catch {
          // ignore
        }

        // Mode Realtime: Audio de Twilio (μ-law 8kHz) → conversion μ-law 8kHz → PCM16 24kHz (OpenAI input_audio_format=pcm16)
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            try {
              const mulawBuffer = Buffer.from(audioBase64, "base64");

              // Barge-in: si l'utilisateur commence réellement à parler pendant que l'IA parle, on annule la réponse.
              const avg = avgAbsMulaw(mulawBuffer);
              const isUserSpeech = avg > TWILIO_SPEECH_THRESHOLD;
              if (isUserSpeech) twilioSpeechFrames += 1;
              else twilioSpeechFrames = Math.max(0, twilioSpeechFrames - 1);
              // IMPORTANT: si TV/bruit en fond, le barge-in coupe sans arrêt. On le désactive par défaut.
              if (BARGE_IN_ENABLED && responseInProgress && twilioSpeechFrames >= BARGE_IN_FRAMES) {
                cancelResponseForBargeIn();
                twilioSpeechFrames = 0;
              }

              // Anti-écho / anti-TV:
              // Si l'IA parle (ou qu'il reste du backlog sortant à jouer), ne pas forward l'audio entrant à OpenAI.
              // Sinon OpenAI détecte speech_started (écho/TV) et les réponses deviennent tronquées / "pas naturelles".
              // IMPORTANT: Si le barge-in est désactivé, on est beaucoup plus permissif pour permettre à l'IA de comprendre l'utilisateur.
              const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
              
              // IMPORTANT: Bloquer l'input tant que l'IA n'a pas fini de parler
              // On bloque si :
              // 1. Une réponse est en cours (responseInProgress)
              // 2. OU ElevenLabs est en train de synthétiser (premiumTtsInFlight)
              // 3. OU il reste du backlog audio à jouer (même petit)
              // Cela garantit que l'IA finit sa phrase avant d'écouter le client
              const assistantIsReallyTalking = 
                responseInProgress || 
                premiumTtsInFlight ||
                assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES;
              
              const suppressInputNow = INPUT_SUPPRESS_WHILE_TALKING && assistantIsReallyTalking;
              if (suppressInputNow) {
                // Si barge-in désactivé, on bloque complètement tant que l'IA parle
                // (pas de seuil d'override pour permettre la parole claire)
                if (!BARGE_IN_ENABLED) {
                  // Blocage total : l'IA doit finir avant d'écouter
                  return;
                } else {
                  // Barge-in activé : seuil normal pour permettre l'interruption
                  if (avg < INPUT_SUPPRESS_OVERRIDE_THRESHOLD) return;
                }
              }
              
              if (mediaCount <= 3) {
                console.log(`🔊 Frame ${mediaCount} audio (μ-law):`, {
                  mulawLength: mulawBuffer.length,
                  mulawFirstBytes: Array.from(mulawBuffer.slice(0, 5)),
                  hasPayload: !!audioBase64,
                  payloadLength: audioBase64.length
                });
              }
              
              // Détection parole/silence (debug)
              const avgLocal = avg;
              lastInputAudioLevel = avgLocal; // Mettre à jour pour filtrer les faux positifs OpenAI
              const isSpeechDbg = avgLocal > INPUT_SPEECH_THRESHOLD;
              const isSilenceDbg = avgLocal < INPUT_SILENCE_THRESHOLD;
              if (isSpeechDbg) {
                localDbgSpeechActive = true;
                silenceFrames = 0;
              } else if (isSilenceDbg) {
                silenceFrames += 1;
                if (silenceFrames >= INPUT_SILENCE_FRAMES) localDbgSpeechActive = false;
              } else {
                silenceFrames = Math.max(0, silenceFrames - 1);
              }
              if (LOG_VAD && mediaCount % 200 === 0) {
                console.log("🎚️ VAD (debug):", {
                  avgAbs: Math.round(avgLocal),
                  speechActive: localDbgSpeechActive,
                  silenceFrames,
                  appendedBytes,
                  fmt: OPENAI_AUDIO_FORMAT,
                });
              }

              // Convertir μ-law 8kHz → PCM16 24kHz
              const pcm24k = convertMulawToPcm24k(mulawBuffer);

              // Buffer little-endian
              const pcm24kBuffer = Buffer.allocUnsafe(pcm24k.length * 2);
              for (let i = 0; i < pcm24k.length; i++) {
                pcm24kBuffer.writeInt16LE(pcm24k[i], i * 2);
              }
              const pcm24kBase64 = pcm24kBuffer.toString("base64");
              appendedBytes += pcm24kBuffer.length;

              // INPUT gate: n'envoie vers OpenAI que quand on a de la parole confirmée.
              if (!INPUT_GATE_ENABLED) {
                openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24kBase64 }));
              } else {
                const isSpeech = avgLocal > INPUT_SPEECH_THRESHOLD;
                const isSilence = avgLocal < INPUT_SILENCE_THRESHOLD;
                if (isSpeech) {
                  inputSpeechFrames += 1;
                  inputSilenceFrames = 0;
                } else if (isSilence) {
                  inputSilenceFrames += 1;
                  inputSpeechFrames = Math.max(0, inputSpeechFrames - 1);
                } else {
                  // zone intermédiaire
                  inputSpeechFrames = Math.max(0, inputSpeechFrames - 1);
                  inputSilenceFrames = Math.max(0, inputSilenceFrames - 1);
                }

                // Démarrage prise de parole après N frames de parole
                if (!inputActive && inputSpeechFrames >= INPUT_SPEECH_FRAMES) {
                  inputActive = true;
                  bytesSinceInputStart = 0;
                }

                if (inputActive) {
                  openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24kBase64 }));
                  bytesSinceInputStart += pcm24kBuffer.length;
                }

                // Fin de prise de parole: silence stable
                if (inputActive && inputSilenceFrames >= INPUT_SILENCE_FRAMES) {
                  const now = nowMs();
                  const minCommitBytes = 4800; // 100ms @ 24kHz PCM16
                  const canCommit = (now - lastInputCommitAt) > 300;
                  // Par défaut, on NE commit pas côté client (OpenAI auto-commit). Ça évite commit_empty et réponses fantômes.
                  if (LOCAL_COMMIT_ENABLED && canCommit && bytesSinceInputStart >= minCommitBytes) {
                    lastInputCommitAt = now;
                    openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                    requestResponseCreate("local_vad_commit");
                  }
                  // reset fenêtre
                  inputActive = false;
                  inputSpeechFrames = 0;
                  inputSilenceFrames = 0;
                  bytesSinceInputStart = 0;
                }
              }

              // IMPORTANT: On ne commit PAS ici (ça crée des commits concurrents et des réponses qui se chevauchent).
              // Le commit est déclenché par input_audio_buffer.speech_stopped (VAD OpenAI).
              
            } catch (err) {
              console.error(`❌ Erreur frame ${mediaCount} conversion/envoi audio à OpenAI:`, err);
            }
          } else {
            if (mediaCount <= 3) {
              console.log(`⚠️ Frame ${mediaCount}: pas de payload audio`);
            }
          }
        } else {
          // OpenAI WS pas encore prêt: bufferiser quelques frames pour éviter de perdre le début de phrase.
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            // Conserver ~1 seconde max
            const mulawLen = 160;
            preOpenFrames.push({ audioBase64, mulawLen, ts: nowMs() });
            preOpenBytes += mulawLen;
            while (preOpenFrames.length > 50) {
              preOpenFrames.shift();
              preOpenBytes = Math.max(0, preOpenBytes - mulawLen);
            }
          }
          if (mediaCount <= 5) {
            console.log(`⚠️ Frame ${mediaCount}: OpenAI WS pas connecté, état:`, openaiWs?.readyState);
          }
        }

        // Le pacing sortant est géré par le timer 20ms.
        
      } else if (msg.event === "stop") {
        console.log("🛑 Stream stop (Twilio a demandé l'arrêt)");
        console.log("🛑 Raison possible: timeout, erreur Twilio, ou fin d'appel normale");
        // Nettoyer les timers de hangup automatique
        if (goodbyeTimer) {
          clearTimeout(goodbyeTimer);
          goodbyeTimer = null;
        }
        if (plateSmsSendOnFinalize) {
          plateSmsSendOnFinalize = false;
          console.log("📩 Envoi SMS plaque demandé à la fin de l'appel (stop event)");
          requestPlateSmsIfNeeded("send_plate_sms_on_finalize")
            .then((res) => {
              console.log("📩 Résultat envoi SMS plaque (stop):", res);
              if (res && res.sent) {
                plateSmsWaitingForReply = true;
                if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
                plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
              } else {
                console.warn("⚠️ SMS plaque non envoyé (stop):", res?.reason || "unknown");
              }
            })
            .catch((err) => {
              console.error("❌ Erreur envoi SMS plaque (stop):", err);
            });
        } else {
          console.log("ℹ️ Aucun SMS plaque à envoyer (plateSmsSendOnFinalize=false)");
        }
        finalizeCallToAutoGuru("twilio_stop");
        if (outboundTimer) {
          clearInterval(outboundTimer);
          outboundTimer = null;
        }
        if (openaiWs) {
          console.log("🛑 Fermeture connexion OpenAI...");
          try {
            // Vérifier l'état avant de fermer
            if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
              openaiWs.close();
            } else {
              console.log("🛑 OpenAI WS déjà fermé ou en cours de fermeture (état:", openaiWs.readyState, ")");
            }
          } catch (err) {
            console.error("❌ Erreur lors de la fermeture OpenAI WS:", err);
          }
        }
      } else {
        console.log("ℹ️ Other event:", msg.event);
      }
    } catch (err) {
      console.error("❌ Invalid message", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Connection closed. Media frames total:", mediaCount);
    if (plateSmsSendOnFinalize) {
      plateSmsSendOnFinalize = false;
      console.log("📩 Envoi SMS plaque demandé à la fermeture du WebSocket");
      requestPlateSmsIfNeeded("send_plate_sms_on_finalize_ws_close")
        .then((res) => {
          console.log("📩 Résultat envoi SMS plaque (ws close):", res);
          if (res && res.sent) {
            plateSmsWaitingForReply = true;
            if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
            plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
          } else {
            console.warn("⚠️ SMS plaque non envoyé (ws close):", res?.reason || "unknown");
          }
        })
        .catch((err) => {
          console.error("❌ Erreur envoi SMS plaque (ws close):", err);
        });
    }
    finalizeCallToAutoGuru("ws_close");
    if (outboundTimer) {
      clearInterval(outboundTimer);
      outboundTimer = null;
    }
    if (openaiWs) {
      openaiWs.close();
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err);
    console.error("❌ WS error details:", {
      message: err.message,
      code: err.code,
      stack: err.stack?.substring(0, 500),
    });
  });
});
