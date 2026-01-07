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
  let premiumTtsAbort = null;
  let premiumTtsBypassUntilMs = 0; // si TTS premium échoue, on laisse passer l'audio OpenAI un moment
  let premiumTtsInFlight = false;
  let premiumTtsLastError = null;
  let premiumTtsQueue = []; // Array<{ text: string, interrupt: boolean }>
  let premiumTtsDrainInFlight = false;

  // AutoGuru ingest (pour remplir "détails d'appel" même en mode Realtime)
  // AutoGuru ingest: par défaut via env (legacy), mais en multi-garages on préfère
  // recevoir URL+token par appel via Twilio <Parameter> (verrouillé par garage).
  const AUTOGURU_INGEST_URL_ENV = process.env.AUTOGURU_INGEST_URL ?? ""; // ex: https://<autoguru>/api/twilio/realtime-ingest
  const AUTOGURU_INGEST_SECRET_ENV = process.env.AUTOGURU_INGEST_SECRET ?? "";
  let autoguruIngestUrl = "";
  let autoguruIngestToken = "";
  let assistantName = "Sandra";
  let assistantVoice = "female"; // "female" | "male"
  let garageTone = "";
  let consentRequired = true;
  let appointmentMode = "request";
  let garageClosed = false;
  let garageClosedReason = "";
  let garageClosedText = "";
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

  async function requestPlateSmsIfNeeded(trigger = "assistant_plate_request") {
    try {
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return;
      if (!callSid) return;
      const to = String(fromNumber || "").trim();
      if (!/^\+\d{8,15}$/.test(to)) return;

      // Anti-spam: une fois par appel
      if (ws.__plateSmsRequested) return;
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
        console.log("📩 SMS plaque demandé à AutoGuru.", { trigger, smsSid: json?.smsSid ?? null });
      } else if (resp) {
        const t = await resp.text().catch(() => "");
        console.warn("⚠️ SMS plaque request non-ok:", { status: resp.status, trigger, body: t.slice(0, 180) });
        // Fallback UX: si le SMS ne peut pas partir, on repasse en collecte orale
        enqueueElevenLabsTts(
          "Je n’arrive pas à vous envoyer le SMS. Dites-moi la plaque à l’oral, lettre par lettre s’il vous plaît.",
          { interrupt: true },
        );
      } else {
        console.warn("⚠️ SMS plaque request: aucune réponse (fetch échoué).", { trigger });
        enqueueElevenLabsTts(
          "Petit souci d’envoi du SMS. Dites-moi la plaque à l’oral, lettre par lettre s’il vous plaît.",
          { interrupt: true },
        );
      }
    } catch {
      // ignore
    }
  }

  // --- SMS plaque : consentement + attente réponse ---
  let plateSmsConsentPending = false;
  let plateSmsConsentDeadlineMs = 0;
  let plateSmsWaitingForReply = false;
  let plateSmsPollTimer = null;

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

      // Dire au client qu'on a bien reçu la plaque, puis continuer
      const confirmText = `Parfait, j’ai bien reçu votre plaque ${plate}. Merci.`;
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

  function enqueueElevenLabsTts(text, { interrupt = true } = {}) {
    if (!PREMIUM_TTS_ENABLED) return;
    const clean = normalizeFrenchTtsText((text || "").trim());
    if (!clean) return;

    // Si le client parle, on retarde la réponse (sinon ça parle par-dessus).
    if (OUTPUT_WAIT_FOR_USER_SILENCE && outUserSpeaking) {
      if (interrupt) pendingSpeakQueue = [];
      pendingSpeakQueue.push(clean);
      return;
    }

    // Si interrupt: on coupe net et on repart avec la nouvelle phrase
    if (interrupt) {
      premiumTtsQueue = [];
      try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
      premiumTtsAbort = new AbortController();
      outboundQueue = [];
      outboundQueuedBytes = 0;
    }

    premiumTtsQueue.push({ text: clean, interrupt });
    void drainElevenLabsQueue();
  }

  async function drainElevenLabsQueue() {
    if (premiumTtsDrainInFlight) return;
    premiumTtsDrainInFlight = true;
    try {
      while (premiumTtsQueue.length > 0) {
        const job = premiumTtsQueue.shift();
        if (!job) continue;
        // Interrupt a déjà été géré à l'enqueue: ici on ne re-clear pas l'audio.
        await speakWithElevenLabsNow(job.text, { interrupt: false });
      }
    } finally {
      premiumTtsDrainInFlight = false;
    }
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

  // Pré-traitement TTS (améliore articulation/intonation en téléphonie)
  function normalizeFrenchTtsText(input) {
    let t = String(input || "").trim();
    if (!t) return "";
    // Nettoyage léger
    t = t.replace(/\s+/g, " ");
    // Abbréviations courantes
    t = t.replace(/\bRDV\b/gi, "rendez-vous");
    t = t.replace(/\bOK\b/g, "ok");
    // Prononciations FR (téléphonie): quelques marques / mots souvent mal dits
    // (simple dictionnaire, sans sur-optimiser)
    t = t.replace(/\bSEAT\b/g, "Siat");
    t = t.replace(/\bSeat\b/g, "Siat");
    t = t.replace(/\bPeugeot\b/gi, "Peujo");
    t = t.replace(/\bRenault\b/gi, "Renô");
    t = t.replace(/\bCitro[eë]n\b/gi, "Citroën");
    t = t.replace(/\bVolkswagen\b/gi, "Volksvaguen");
    t = t.replace(/\bMercedes\b/gi, "Mèr-cè-dès");
    t = t.replace(/\bNorauto\b/gi, "Norauto");
    // Ponctuation FR (aide l'intonation)
    t = t.replace(/\s*([!?;:])\s*/g, "$1 ");
    t = t.replace(/\s*([,.])\s*/g, "$1 ");
    // Pauses naturelles
    t = t.replace(/(\d)\s*km\b/gi, "$1 kilomètres");
    // Eviter les très longues phrases (téléphonie)
    if (t.length > 220 && !/[.!?]/.test(t.slice(-20))) t += ".";
    return t.trim();
  }

  // Détection parole côté Twilio (pour barge-in) : plus stable que les events VAD OpenAI en environnement bruyant.
  const BARGE_IN_ENABLED = (process.env.BARGE_IN_ENABLED ?? "false").toLowerCase() === "true";
  const TWILIO_SPEECH_THRESHOLD = Number(process.env.BARGE_IN_THRESHOLD ?? "5500");
  const BARGE_IN_FRAMES = Number(process.env.BARGE_IN_FRAMES ?? "12"); // ~240ms (12 * 20ms)
  let twilioSpeechFrames = 0;

  // Noise gate / VAD local pour l'INPUT (évite que la TV/bruit déclenche des réponses automatiques).
  // IMPORTANT: en pratique, trop agressif peut faire "l'IA ne répond pas".
  // Donc par défaut on l'active seulement si la variable Render est explicitement à true.
  // En realtime, on active le gate par défaut pour éviter que l'IA réponde sur une micro-pause.
  const INPUT_GATE_ENABLED = (process.env.INPUT_GATE_ENABLED ?? (PIPELINE_MODE === "realtime" ? "true" : "false")).toLowerCase() === "true";
  // Valeurs plus tolérantes par défaut (sinon voix faible => aucune parole détectée)
  const INPUT_SPEECH_THRESHOLD = Number(process.env.INPUT_SPEECH_THRESHOLD ?? "900");
  const INPUT_SPEECH_FRAMES = Number(process.env.INPUT_SPEECH_FRAMES ?? "6"); // ~120ms
  const INPUT_SILENCE_THRESHOLD = Number(process.env.INPUT_SILENCE_THRESHOLD ?? "450");
  const INPUT_SILENCE_FRAMES = Number(process.env.INPUT_SILENCE_FRAMES ?? (PIPELINE_MODE === "realtime" ? "28" : "20")); // ~560ms en realtime
  let inputSpeechFrames = 0;
  let inputSilenceFrames = 0;
  let inputActive = false; // on est en train d'envoyer une "prise de parole" à OpenAI
  let bytesSinceInputStart = 0;
  let lastInputCommitAt = 0;
  const LOCAL_COMMIT_ENABLED = (process.env.LOCAL_COMMIT_ENABLED ?? "false").toLowerCase() === "true";
  // Anti-écho: si l'IA parle, on peut ignorer l'audio entrant pour éviter que la TV/retour audio déclenche un nouveau tour.
  const INPUT_SUPPRESS_WHILE_TALKING = (process.env.INPUT_SUPPRESS_WHILE_TALKING ?? "true").toLowerCase() === "true";
  const INPUT_SUPPRESS_BACKLOG_FRAMES = Number(process.env.INPUT_SUPPRESS_BACKLOG_FRAMES ?? "5"); // ~100ms d'audio sortant
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
  const REALTIME_USE_ELEVEN =
    PIPELINE_MODE === "realtime" &&
    REALTIME_TTS_MODE.includes("eleven") &&
    PREMIUM_TTS_ENABLED &&
    PREMIUM_TTS_PROVIDER === "elevenlabs";

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

    if (framesSent > 0 && Math.random() < 0.02) {
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
    if (!OPENAI_API_KEY) {
      console.error("❌ OpenAI API key manquante");
      return;
    }

    try {
      console.log("🔌 Tentative de connexion à OpenAI Realtime API...");
      // Configurer le format audio dans l'URL de connexion.
      // On force PCM16 pour éviter tout mismatch de format en sortie (sinon Twilio joue du bruit).
      const openaiUrl =
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&input_audio_format=pcm16&output_audio_format=pcm16";
      console.log("🔌 URL OpenAI:", openaiUrl.replace(/Bearer\s+\S+/, "Bearer ***"));
      openaiWs = new WebSocket(openaiUrl, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });

      openaiWs.on("open", () => {
        console.log("✅ Connecté à OpenAI Realtime API");
        console.log("🎛️ OpenAI audio format (forced):", { input: "pcm16", output: "pcm16" });
        console.log("📊 Configuration active:", {
          PIPELINE_MODE,
          REALTIME_USE_ELEVEN,
          PREMIUM_TTS_ENABLED,
          LLM_MODEL,
          ELEVENLABS_VOICE_ID: ELEVENLABS_VOICE_ID_FEMALE || ELEVENLABS_VOICE_ID_MALE || ELEVENLABS_VOICE_ID_DEFAULT,
        });
        
        // Log état du fallback au démarrage
        if (REALTIME_USE_ELEVEN) {
          if (nowMs() < premiumTtsBypassUntilMs) {
            const remainingMinutes = Math.ceil((premiumTtsBypassUntilMs - nowMs()) / 60000);
            console.warn("⚠️ FALLBACK ACTIF au démarrage: ElevenLabs en erreur → audio OpenAI (~" + remainingMinutes + " min restantes)");
            if (premiumTtsLastError) {
              console.error("   Dernière erreur ElevenLabs:", premiumTtsLastError);
            }
          } else {
            console.log("✅ ElevenLabs actif (pas de fallback)");
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
              ? "Mode rendez-vous: interne (tu peux proposer un créneau, mais tu confirmes seulement après validation explicite du client)."
              : "Mode rendez-vous: demande (tu NE confirmes PAS de RDV, tu prends une demande et le garage rappelle pour confirmer).";

        const consentLine =
          consentRequired
            ? "Dès le début de l'appel, annonce: 'Cet appel est enregistré pour préparer votre arrivée au garage. Si vous refusez, vous pouvez raccrocher à tout moment.' Puis demande un oui/non."
            : "Consentement enregistrement: non requis.";

        const hoursPolicyLine = `Horaires: l'IA répond H24. Les horaires/vacances sont PUREMENT informatifs pour le client (pas bloquants, pas de raccrochage automatique).`;
        const closedInfoLine = garageClosed
          ? `Info horaires (interne): le garage est actuellement indiqué comme fermé. (${garageClosedReason || "closed"}) ${garageClosedText || ""} Tu NE le mentionnes PAS au début. Tu le mentionnes uniquement en fin d'appel, selon les règles ci-dessous.`
          : "Info horaires (interne): garage indiqué ouvert.";
        const pricingLine = pricingSummary
          ? `Tarifs du garage (à utiliser si le client demande un prix, sans inventer): ${pricingSummary}
IMPORTANT: Si un tarif contient "(le prix peut varier selon le véhicule)", tu DOIS donner le prix indiqué ET préciser que le prix peut varier selon le véhicule. Exemple: "Pour une vidange, c'est environ 45€, mais le prix peut varier selon le véhicule."`
          : "Tarifs du garage: non renseignés (si le client demande un prix, tu expliques que c'est sur devis ou à confirmer).";

        const servicesLine = servicesSummary
          ? `Services disponibles au garage (utilise ces infos pour répondre aux questions): ${servicesSummary}`
          : "";

        const faqsLine = faqsSummary
          ? `Questions fréquentes (utilise ces réponses si le client pose une question similaire): ${faqsSummary}`
          : "";

        const baseInstructions = `Tu es ${assistantName}, l'assistant(e) téléphonique de ${garageLabel}.
Tu réponds à des appels téléphoniques (style oral, naturel, vivant).
Objectif: comprendre précisément le besoin, rassurer, et avancer vers une prise en charge (selon le mode RDV).
${modeLine}
${consentLine}
${hoursPolicyLine}
${closedInfoLine}
${pricingLine}
${servicesLine ? `${servicesLine}\n` : ""}${faqsLine ? `${faqsLine}\n` : ""}Style: chaleureux, pro, un peu "commercial" (donner envie), mais jamais insistant.
Format: réponses courtes (1 à 2 phrases), puis UNE question.
Intonation/rythme: utilise la ponctuation pour sonner naturel (phrases courtes, virgules, questions).`;

        const mechanicPersona =
          `Persona: tu es ${assistantName}, quelqu'un de très humain au téléphone au garage (pas un robot).
Tu as une voix chaleureuse, avec de la vie, et tu mets à l'aise.
Tu restes dans un registre garage/auto.
${garageTone ? `Ton du garage (à respecter): ${garageTone}` : ""}

Méthode (pour collecter un maximum d'infos utiles, sans faire interrogatoire):
- 1) Comprendre le besoin en 1 phrase ("ok, je vois").
- 2) Poser 2 à 4 questions ciblées maximum, selon le cas, par exemple:
  - Véhicule: marque + modèle + année (si pas de plaque), ou kilométrage approximatif.
  - Symptômes: depuis quand ? bruit/voyant/odeur/fumée ? conditions (à froid/à chaud/en freinant/en tournant) ?
  - Urgence/sécurité: voyant rouge ? perte de puissance ? freinage ? fuite ?
  - Contrainte: dispo jour + matin/après-midi, et si véhicule immobilisé ou non.
- 3) Reformuler en 1 phrase ce que tu as compris.
- 4) Proposer la suite (demande RDV / rappel / conseil sécurité).

Règles de langage:
- Tu vouvoies par défaut, tu peux tutoyer seulement si le client tutoie.
- Tu ne dis jamais que tu es une IA.
- Tu utilises parfois des petites formules ("ok", "très bien", "pas de souci") SANS répétition.
- Tu parles en petites phrases, naturelles, comme une vraie personne.

But: préparer le dossier pour l'atelier (que le garage puisse rappeler efficacement).`;

        const vehicleInfoRule = collectVehicleInfo
          ? `- Si le client n'a pas la plaque: tu demandes marque + modèle + année (ou kilométrage).`
          : `- Si le client n'a pas la plaque: tu NE demandes PAS systématiquement marque/modèle/année. Tu ne demandes ces infos que si c'est indispensable (ex: tarif variable), et tu restes léger ("Quel véhicule c'est ?").`;

        const hardConstraints =
          `IMPORTANT:
- Tu es un garage auto. Tu parles UNIQUEMENT de véhicules/diagnostic/rendez-vous.
- Si le client dit "j'ai un problème", tu poses des questions sur le véhicule (bruit/voyant/démarrage/freinage) et tu proposes un RDV.
- Tu dois collecter la plaque d'immatriculation (ex: AB-123-CD) dès que possible.
- Si le client demande un tarif ET que le tarif est dans "Tarifs du garage":
  * Si le tarif est fixe (ex: "45€"), tu le donnes directement et tu proposes la suite (RDV ou dépôt). Tu n'exiges pas marque/modèle dans ce cas.
  * Si le tarif est variable (contient "le prix peut varier selon le véhicule"), tu donnes le prix indiqué ET tu précises que le prix peut varier selon le véhicule. Exemple: "Pour une vidange, c'est environ 45€, mais le prix peut varier selon le véhicule. Quel véhicule avez-vous ?" Dans ce cas, tu peux demander marque/modèle pour affiner.
- Si le client demande un tarif ET qu'il n'y a pas de tarif renseigné, tu dis que c'est à confirmer/devis et tu proposes RDV; tu peux demander le véhicule UNIQUEMENT si nécessaire.
- Utilise les informations des "Services disponibles" et "Questions fréquentes" pour répondre aux questions du client de manière précise et cohérente avec les infos du garage.
${vehicleInfoRule}
- Tu n'inventes JAMAIS une plaque. Si la plaque est partielle, ambiguë, ou trop courte (ex: un seul chiffre), tu dis que ce n'est pas suffisant et tu demandes de la redire lettre par lettre, chiffres par chiffres.
- Quand tu répètes une plaque, tu la répètes exactement comme donnée. Si tu n'es pas sûr à 100%, tu demandes de confirmer au lieu de valider.
- Quand tu as besoin de la plaque, tu proposes PRIORITAIREMENT: "Je vous envoie un SMS, répondez-y avec la plaque, ça l'enregistre automatiquement." puis tu demandes confirmation ("Ça vous va ?").
- Si le client donne une préférence de créneau (ex: "le matin", "l'après-midi"), tu DOIS la respecter et la reformuler.
- Tu ne confirmes jamais un rendez-vous à une autre période que celle demandée. Si tu as un doute, tu demandes confirmation.
- Si mode rendez-vous = demande: tu ne dis jamais "c'est confirmé" / "c'est fixé". Tu dis "je note la demande" et "on vous rappelle pour confirmer".
- Si mode rendez-vous = demande: tu demandes UNIQUEMENT les disponibilités (jour + plutôt matin/après-midi). Tu peux suggérer des options ("demain / après-demain") mais tu précises que ce n'est pas confirmé.
- Si mode rendez-vous = aucun: tu ne proposes pas de RDV. Tu prends les infos et tu dis que le garage rappelle.
- Ne dis JAMAIS: "ce que vous avez sur le cœur" / "dans la tête" / conseils psychologiques.`;

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
          `Persona: assistant téléphonique professionnel, cordial et concis.`;

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
          },
        };
        if (REALTIME_INPUT_TRANSCRIPTION_ENABLED) {
          sessionUpdate.session.input_audio_transcription = {
            model: REALTIME_INPUT_TRANSCRIPTION_MODEL,
            language: REALTIME_INPUT_TRANSCRIPTION_LANGUAGE,
          };
        }
        // On ajoute des contraintes fortes (évite les réponses "hors sujet" type coach de vie).
        sessionUpdate.session.instructions =
          `${baseInstructions}\n\n${ASSISTANT_PERSONA === "mecanicien" ? mechanicPersona : neutralPersona}\n\n${variationGuidelines}\n\n${hardConstraints}\n\n${closingGuidelines}`;
        // Stocke pour fallback en cas de unknown_parameter (session.update partiellement appliquée)
        ws.__sessionInstructions = String(sessionUpdate.session.instructions || "");

        openaiWs.send(JSON.stringify(sessionUpdate));

        function pickGreetingText(label) {
          const greetings = [
            `Bonjour ! Je suis ${assistantName}, l'assistante du ${label}. En quoi puis-je vous aider ?`,
            `Bonjour, ${assistantName} à l'appareil, du ${label}. Qu'est-ce qui vous amène ?`,
            `Bonjour ! Ici ${assistantName}, du ${label}. Dites-moi ce qui se passe avec votre voiture.`,
            `Bonjour, vous êtes bien au ${label}. Je suis ${assistantName}. En quoi je peux vous aider ?`,
            `Bonjour ! Je suis ${assistantName} du ${label}. C'est un bruit, un voyant, ou un souci au démarrage ?`,
          ];
          return greetings[Math.floor(Math.random() * greetings.length)];
        }

        // Si on a déjà joué un greeting local (ElevenLabs) avant l'ouverture OpenAI,
        // on l'injecte dans la conversation pour éviter que le modèle le répète.
        if (initialAssistantGreetingText && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          try {
            openaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                // Realtime: pour un message assistant, le type attendu est "output_text"
                content: [{ type: "output_text", text: initialAssistantGreetingText }],
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

              // Si on a déjà joué un greeting local (ElevenLabs), ne pas en redemander un à OpenAI.
              if (initialAssistantGreetingText) {
                console.log("👋 Greeting OpenAI ignoré (greeting déjà joué via ElevenLabs).", { callSid });
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
          
          // Transcripts de sortie (utile pour TTS premium)
          if (msg.type === "response.created") {
            const rid = msg.response?.id ?? msg.response_id ?? null;
            if (rid) transcriptMap.set(rid, "");
            if (rid && REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
              elevenStateMap.set(rid, { cursor: 0, started: false });
            }
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
          if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const doneText = (typeof msg.transcript === "string" ? msg.transcript : "") || (rid ? (transcriptMap.get(rid) || "") : "");
            if (REALTIME_USE_ELEVEN && doneText && doneText.trim()) {
              // Remonter l'IA dans AutoGuru (détails d'appel)
              enqueueIngest("assistant", doneText);
              // Si l'assistant parle de plaque, proposer SMS MAIS NE PAS ENVOYER avant accord du client.
              const low = String(doneText || "").toLowerCase();
              if (low.includes("plaque") || low.includes("immatric")) {
                // Mode "consentement": on attend un "oui" utilisateur
                plateSmsConsentPending = true;
                plateSmsConsentDeadlineMs = nowMs() + 25_000;
              }
              // Fallback: si OpenAI a compris l'accord ("super/parfait/merci/ok") mais que notre STT local n'a pas capté le "oui",
              // on déclenche quand même l'envoi SMS (sinon le SMS ne part jamais).
              if (plateSmsConsentPending && nowMs() <= plateSmsConsentDeadlineMs) {
                const soundsLikeAcceptance =
                  /\b(super|parfait|merci|ok|tr[eè]s bien)\b/.test(low) &&
                  (low.includes("disponible") || low.includes("rendez-vous") || low.includes("rdv") || low.includes("quand"));
                if (soundsLikeAcceptance) {
                  plateSmsConsentPending = false;
                  console.log("📩 Fallback consent détecté via réponse IA → envoi SMS plaque.");
                  await requestPlateSmsIfNeeded("assistant_inferred_user_acceptance");
                  plateSmsWaitingForReply = true;
                  if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
                  plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
                }
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
                enqueueElevenLabsTts(doneText, { interrupt: true });
              }
            }
          }
          
          // IMPORTANT: selon les versions, le delta audio peut arriver sous:
          // - response.audio.delta
          // - response.output_audio.delta
          if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
            // Si on utilise ElevenLabs en Realtime, on ignore complètement l'audio OpenAI (sinon doublon + backlog).
            // SAUF si ElevenLabs est en erreur (bypass) → on repasse sur OpenAI pour éviter le silence total.
            if (REALTIME_USE_ELEVEN && nowMs() >= premiumTtsBypassUntilMs) {
              // ElevenLabs actif, on ignore l'audio OpenAI
              return;
            }
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
          if (msg.type === "input_audio_buffer.speech_started") {
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
        console.error("❌ Erreur OpenAI WS:", err);
        console.error("❌ OpenAI WS error details:", {
          message: err.message,
          code: err.code,
          stack: err.stack?.substring(0, 500),
        });
      });

      openaiWs.on("close", (code, reason) => {
        console.log("🔌 OpenAI WS fermé", { code, reason: reason?.toString() });
        if (code !== 1000) {
          console.warn("⚠️ OpenAI WS fermé anormalement (code != 1000)");
        }
      });
    } catch (err) {
      console.error("Erreur connexion OpenAI:", err);
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
        if (typeof finalCollectVehicleInfo === "string" && finalCollectVehicleInfo.trim()) collectVehicleInfo = finalCollectVehicleInfo.trim().toLowerCase() === "true";
        if (typeof finalPricingSummary === "string") pricingSummary = String(finalPricingSummary || "").trim();
        if (typeof finalServicesSummary === "string") servicesSummary = String(finalServicesSummary || "").trim();
        if (typeof finalFaqsSummary === "string") faqsSummary = String(finalFaqsSummary || "").trim();

        // Toujours logguer la config au démarrage d'un stream pour diagnostiquer Render env vs code path.
        logPipelineConfigOnce("⚙️ Pipeline actif");

        // 🔥 Greeting immédiat (ultra-réactif) :
        // - doit annoncer l'enregistrement AVANT que le client puisse répondre
        // - doit utiliser la voix ElevenLabs (pas attendre OpenAI)
        // - on injecte ensuite le même texte dans la conversation OpenAI pour éviter les répétitions
        try {
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          if ((!greetOncePerCall || !hasGreetedRecently(callSid)) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN) {
            const rawName = String(garageName || "AutoGuru").trim();
            const label = /^garage\b/i.test(rawName) ? rawName : `Garage ${rawName}`;
            const baseHello = `Bonjour ! Ici ${assistantName}, du ${label}.`;
            const consentText = consentRequired
              ? "Cet appel est enregistré pour préparer votre arrivée au garage. Si vous refusez, vous pouvez raccrocher à tout moment."
              : "";
            const question = consentRequired
              ? "Est-ce que ça vous convient ?"
              : "En quoi je peux vous aider ?";
            const greeting = [baseHello, consentText, question].filter(Boolean).join(" ");
            initialAssistantGreetingText = greeting;
            enqueueElevenLabsTts(greeting, { interrupt: true });
            console.log("👋 Greeting immédiat joué via ElevenLabs.", { callSid, consentRequired });
            if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
          }
        } catch (e) {
          console.error("❌ Erreur greeting immédiat ElevenLabs:", e);
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
          const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
          const assistantIsTalking =
            responseInProgress ||
            premiumTtsInFlight ||
            assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES;
          if (INPUT_SUPPRESS_WHILE_TALKING && assistantIsTalking) return;

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
                        // Gestion consentement SMS plaque
                        if (plateSmsConsentPending && nowMs() <= plateSmsConsentDeadlineMs) {
                          if (isAffirmativeFr(txt)) {
                            plateSmsConsentPending = false;
                            // Envoyer le SMS maintenant
                            requestPlateSmsIfNeeded("user_accepted_plate_sms");
                            // Démarrer le polling
                            plateSmsWaitingForReply = true;
                            if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
                            plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
                            // Petite phrase "j'attends votre réponse au SMS"
                            enqueueElevenLabsTts("Parfait. Je vous laisse 2 secondes : répondez au SMS avec la plaque, et je continue.", { interrupt: true });
                          } else if (isNegativeFr(txt)) {
                            plateSmsConsentPending = false;
                            enqueueElevenLabsTts("D'accord. Dans ce cas, dites-moi la plaque lettre par lettre, s'il vous plaît.", { interrupt: true });
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
              const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
              const assistantIsTalking =
                responseInProgress ||
                premiumTtsInFlight ||
                assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES;
              const suppressInputNow = INPUT_SUPPRESS_WHILE_TALKING && assistantIsTalking && !BARGE_IN_ENABLED;
              if (suppressInputNow && avg < INPUT_SUPPRESS_OVERRIDE_THRESHOLD) return;
              
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
              if (mediaCount % 200 === 0) {
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
        finalizeCallToAutoGuru("twilio_stop");
        if (outboundTimer) {
          clearInterval(outboundTimer);
          outboundTimer = null;
        }
        if (openaiWs) {
          console.log("🛑 Fermeture connexion OpenAI...");
          openaiWs.close();
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

