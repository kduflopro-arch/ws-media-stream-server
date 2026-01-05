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
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.25");
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
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.25");
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
const PIPELINE_MODE = (process.env.PIPELINE_MODE ?? "realtime").toLowerCase();

// Serveur HTTP explicite (meilleur contrôle + endpoint /health pour garder Render "chaud")
const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
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
});

wss.on("connection", (ws, req) => {
  console.log("New Media Stream connection:", req.url);
  
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
  let loggedFirstAudioDelta = false;
  let outboundTimer = null;
  let lastResponseAt = 0;
  let awaitingUserResponse = false;
  let droppedOutboundBytes = 0;
  // Debug VAD local (ne doit PAS impacter la logique OpenAI)
  let localDbgSpeechActive = false;
  
  // Mode "voix premium" (TTS externe). Si activé, on ignore l'audio OpenAI et on lit une voix premium via TTS.
  const PREMIUM_TTS_ENABLED = (process.env.PREMIUM_TTS_ENABLED ?? "false").toLowerCase() === "true";
  const PREMIUM_TTS_PROVIDER = (process.env.PREMIUM_TTS_PROVIDER ?? "elevenlabs").toLowerCase();
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? ""; // voice masculine (à choisir dans ElevenLabs)
  const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
  const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT ?? "pcm_16000";
  let premiumTtsAbort = null;
  let premiumTtsBypassUntilMs = 0; // si TTS premium échoue, on laisse passer l'audio OpenAI un moment
  let premiumTtsInFlight = false;
  let premiumTtsLastError = null;

  // Option B (STT → LLM → TTS)
  const STT_MODEL = process.env.STT_MODEL ?? "whisper-1";
  const STT_LANGUAGE = process.env.STT_LANGUAGE ?? "fr";
  const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o";
  const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? "0.4");
  const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? "220");
  const STT_SPEECH_THRESHOLD = Number(process.env.STT_SPEECH_THRESHOLD ?? "2200");
  const STT_SPEECH_FRAMES = Number(process.env.STT_SPEECH_FRAMES ?? "6"); // ~120ms
  const STT_SILENCE_THRESHOLD = Number(process.env.STT_SILENCE_THRESHOLD ?? "1200");
  const STT_SILENCE_FRAMES = Number(process.env.STT_SILENCE_FRAMES ?? "18"); // ~360ms
  const STT_MIN_AUDIO_MS = Number(process.env.STT_MIN_AUDIO_MS ?? "400");
  const HISTORY_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS ?? "8");
  let sttSpeechFrames = 0;
  let sttSilenceFrames = 0;
  let sttActive = false;
  let sttBytes = 0;
  let sttStartedAt = 0;
  let sttMulawChunks = []; // Array<Buffer>
  let sttInFlight = false;
  let conversationHistory = []; // Array<{role:'user'|'assistant', content:string}>

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

  async function openaiChat(messages, model) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_TOKENS,
        messages,
      }),
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
        answer = await openaiChat(msgs, LLM_MODEL);
      } catch (err) {
        // Fallback si le modèle demandé (ex: gpt-5) n'est pas disponible
        console.error("❌ LLM primary failed, fallback to gpt-4o:", String(err?.message ?? err));
        answer = await openaiChat(msgs, "gpt-4o");
      }
      if (!answer) return;
      conversationHistory.push({ role: "assistant", content: answer });
      conversationHistory = conversationHistory.slice(-HISTORY_MAX_TURNS * 2);

      await speakWithElevenLabs(answer);
    } catch (err) {
      console.error("❌ Erreur pipeline STT→LLM→TTS:", err);
    } finally {
      sttInFlight = false;
    }
  }

  async function speakWithElevenLabs(text) {
    if (!PREMIUM_TTS_ENABLED) return;
    if (PREMIUM_TTS_PROVIDER !== "elevenlabs") return;
    if (nowMs() < premiumTtsBypassUntilMs) return;
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      console.error("❌ PREMIUM_TTS activé mais ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID manquants.");
      return;
    }
    const clean = (text || "").trim();
    if (!clean) return;

    // Stopper toute synthèse en cours et couper l'audio en file
    try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
    premiumTtsAbort = new AbortController();
    outboundQueue = [];
    outboundQueuedBytes = 0;
    premiumTtsInFlight = true;
    premiumTtsLastError = null;

    try {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream?output_format=${encodeURIComponent(ELEVENLABS_OUTPUT_FORMAT)}`;
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
        }),
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text().catch(() => "");
        premiumTtsLastError = { status: resp.status, body: errText.slice(0, 500) };
        console.error("❌ ElevenLabs TTS error:", premiumTtsLastError);
        // Fallback: laisser passer l'audio OpenAI pendant 5 minutes (sinon silence total)
        premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000;
        console.warn("↩️ Fallback premium: bypass audio OpenAI activé (5 min).");
        return;
      }

      // On suppose un flux PCM16 LE @ 16kHz (pcm_16000) → on convertit en frames μ-law 8kHz de 20ms (160 bytes).
      // Buffer bytes pour alignement + blocs 640 bytes.
      const nodeStream = Readable.fromWeb(resp.body);
      let pcmBuf = Buffer.alloc(0);
      const maxBacklogSeconds = Number(process.env.ELEVENLABS_MAX_BACKLOG_SECONDS ?? "3");
      const maxBacklogBytes = Math.max(160 * 50, Math.floor(8000 * maxBacklogSeconds)); // 8k bytes/sec (μ-law 8kHz)

      for await (const chunk of nodeStream) {
        if (!chunk || chunk.length === 0) continue;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pcmBuf = Buffer.concat([pcmBuf, buf]);
        while (pcmBuf.length >= 640) {
          const block = pcmBuf.subarray(0, 640);
          pcmBuf = pcmBuf.subarray(640);
          const mulawFrame = convertPcm16kBlockToMulaw(block); // 160 bytes
          enqueueOutboundMulaw(mulawFrame);
          // IMPORTANT: éviter de pousser l'audio trop vite (Twilio peut drop / couper si on burst).
          // On applique un throttle basé sur le backlog réel.
          while (outboundQueuedBytes > maxBacklogBytes) {
            await sleep(20);
          }
        }
      }
      // Drop remainder (<20ms) to keep pacing stable.
      console.log("🎙️ ElevenLabs TTS terminé.", { chars: clean.length });
    } catch (err) {
      if (String(err?.name) === "AbortError") return;
      console.error("❌ Erreur ElevenLabs TTS:", err);
      premiumTtsLastError = { message: String(err?.message ?? err) };
      premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000;
      console.warn("↩️ Fallback premium: bypass audio OpenAI activé (5 min).");
    } finally {
      premiumTtsInFlight = false;
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

  // Détection parole côté Twilio (pour barge-in) : plus stable que les events VAD OpenAI en environnement bruyant.
  const BARGE_IN_ENABLED = (process.env.BARGE_IN_ENABLED ?? "false").toLowerCase() === "true";
  const TWILIO_SPEECH_THRESHOLD = Number(process.env.BARGE_IN_THRESHOLD ?? "5500");
  const BARGE_IN_FRAMES = Number(process.env.BARGE_IN_FRAMES ?? "12"); // ~240ms (12 * 20ms)
  let twilioSpeechFrames = 0;

  // Noise gate / VAD local pour l'INPUT (évite que la TV/bruit déclenche des réponses automatiques).
  // IMPORTANT: en pratique, trop agressif peut faire "l'IA ne répond pas".
  // Donc par défaut on l'active seulement si la variable Render est explicitement à true.
  const INPUT_GATE_ENABLED = (process.env.INPUT_GATE_ENABLED ?? "false").toLowerCase() === "true";
  const INPUT_SPEECH_THRESHOLD = Number(process.env.INPUT_SPEECH_THRESHOLD ?? "2500");
  const INPUT_SPEECH_FRAMES = Number(process.env.INPUT_SPEECH_FRAMES ?? "6"); // ~120ms
  const INPUT_SILENCE_THRESHOLD = Number(process.env.INPUT_SILENCE_THRESHOLD ?? "1200");
  const INPUT_SILENCE_FRAMES = Number(process.env.INPUT_SILENCE_FRAMES ?? "20"); // ~400ms
  let inputSpeechFrames = 0;
  let inputSilenceFrames = 0;
  let inputActive = false; // on est en train d'envoyer une "prise de parole" à OpenAI
  let bytesSinceInputStart = 0;
  let lastInputCommitAt = 0;
  const LOCAL_COMMIT_ENABLED = (process.env.LOCAL_COMMIT_ENABLED ?? "false").toLowerCase() === "true";
  // Anti-écho: si l'IA parle, on peut ignorer l'audio entrant pour éviter que la TV/retour audio déclenche un nouveau tour.
  const INPUT_SUPPRESS_WHILE_TALKING = (process.env.INPUT_SUPPRESS_WHILE_TALKING ?? "true").toLowerCase() === "true";
  const INPUT_SUPPRESS_BACKLOG_FRAMES = Number(process.env.INPUT_SUPPRESS_BACKLOG_FRAMES ?? "5"); // ~100ms d'audio sortant

  function requestResponseCreate(reason) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    // Ne pas spam: si OpenAI a déjà une réponse en cours, ou si on vient juste d'en demander une.
    const now = nowMs();
    if (responseInProgress) return;
    if ((now - lastResponseCreateRequestedAt) < 600) return;
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
      console.error("OpenAI API key manquante");
      return;
    }

    try {
      // Configurer le format audio dans l'URL de connexion.
      // On force PCM16 pour éviter tout mismatch de format en sortie (sinon Twilio joue du bruit).
      const openaiUrl =
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&input_audio_format=pcm16&output_audio_format=pcm16";
      openaiWs = new WebSocket(openaiUrl, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });

      openaiWs.on("open", () => {
        console.log("✅ Connecté à OpenAI Realtime API");
        console.log("🎛️ OpenAI audio format (forced):", { input: "pcm16", output: "pcm16" });
        
        // Configurer la session OpenAI
        // Note: input_audio_format et output_audio_format sont configurés dans l'URL WebSocket, pas ici
        const ASSISTANT_PERSONA = (process.env.ASSISTANT_PERSONA ?? "mecanicien").toLowerCase();
        const baseInstructions = `Tu es l'assistant vocal du garage ${garageName || "AutoGuru"}.
Tu réponds à des appels téléphoniques.
Objectif: comprendre la demande et proposer une solution ou un rendez-vous.
Contraintes: phrases courtes, une question à la fois, ton naturel.`;

        const mechanicPersona =
          `Persona: tu es un mécanicien expérimenté et sympa (pas un robot).
Tu parles comme au téléphone: chaleureux, direct, rassurant.
Tu peux utiliser un vocabulaire simple de garage (freins, embrayage, vidange, bruit, voyant…),
mais tu expliques toujours simplement.
Tu vouvoies par défaut, tu peux tutoyer seulement si le client tutoie.
Tu ne dis jamais que tu es une IA.
Quand tu confirmes une info: reformule-la ("d'accord, plaque AB-123-CD").
Si bruit/TV: demande gentiment de se mettre au calme ("Si vous pouvez baisser la télé 2 secondes, ce sera plus net.").`;

        const neutralPersona =
          `Persona: assistant téléphonique professionnel, cordial et concis.`;

        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `${baseInstructions}\n\n${ASSISTANT_PERSONA === "mecanicien" ? mechanicPersona : neutralPersona}`,
          },
        }));

        // IMPORTANT: faire parler l'IA tout de suite (valide le chemin audio Twilio <- OpenAI),
        // même si le client n'a pas encore parlé / même si le VAD n'a pas commit.
        if (!hasSentInitialGreeting) {
          hasSentInitialGreeting = true;
          const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "150");
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          setTimeout(() => {
            try {
              if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
              // Si l'utilisateur a déjà parlé (ou parle), on skip le greeting pour éviter tout chevauchement.
              if (userHasSpoken || speechActive || awaitingUserResponse || responseInProgress) return;
              // Éviter de rejouer l'accueil si Twilio reconnecte pendant le même CallSid
              if (greetOncePerCall && hasGreetedRecently(callSid)) {
                console.log("👋 Greeting ignoré (déjà joué pour ce CallSid).", { callSid });
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
Dis: "Oui allô, bonjour !" puis "Garage ${garageName || "AutoGuru"}, bonjour, je vous écoute."
Ensuite: pose UNE question simple ("Qu'est-ce qui vous amène ?")`,
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

      openaiWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Stockage du texte de réponse (pour mode TTS premium)
          // Map<response_id, transcript>
          if (!ws.__premiumTranscriptByResponseId) ws.__premiumTranscriptByResponseId = new Map();
          const transcriptMap = ws.__premiumTranscriptByResponseId;
          
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
          }
          if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.audio_transcript.delta") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const delta = msg.delta ?? "";
            if (rid && typeof delta === "string") {
              transcriptMap.set(rid, (transcriptMap.get(rid) || "") + delta);
            }
          }
          if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const doneText = (typeof msg.transcript === "string" ? msg.transcript : "") || (rid ? (transcriptMap.get(rid) || "") : "");
            if (PREMIUM_TTS_ENABLED && doneText && doneText.trim()) {
              // Lancer la voix premium
              speakWithElevenLabs(doneText);
            }
          }
          
          // IMPORTANT: selon les versions, le delta audio peut arriver sous:
          // - response.audio.delta
          // - response.output_audio.delta
          if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
            // En mode premium, on ignore l'audio OpenAI (sinon double-voix),
            // SAUF si ElevenLabs est en erreur (bypass) → on repasse sur OpenAI pour éviter le silence total.
            if (PREMIUM_TTS_ENABLED && nowMs() >= premiumTtsBypassUntilMs) return;
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
          }
          
          if (msg.type === "error") {
            console.error("❌ Erreur OpenAI:", msg.error);
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
              }, 400);
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
      });

      openaiWs.on("close", () => {
        console.log("🔌 OpenAI WS fermé");
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
        
        console.log("🎬 Stream start:", {
          streamCallSid,
          streamSid: twilioStreamSid,
          callSid: finalCallSid,
          garageId: finalGarageId,
          garageName: finalGarageName,
          fromNumber: finalFromNumber,
          customParameters: startParams,
          mediaFormat: msg.start?.mediaFormat
        });
        
        // Mettre à jour les variables pour utiliser dans OpenAI
        callSid = finalCallSid;
        garageId = finalGarageId;
        garageName = finalGarageName;
        fromNumber = finalFromNumber;
        
        // Démarrage selon mode pipeline
        if (PIPELINE_MODE === "stt_llm_tts") {
          // Greeting direct via TTS premium (évite le Realtime)
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          if (!greetOncePerCall || !hasGreetedRecently(callSid)) {
            const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "150");
            setTimeout(() => {
              speakWithElevenLabs(`Oui allô, bonjour. Garage ${garageName || "AutoGuru"}, bonjour, je vous écoute. Qu'est-ce qui vous amène ?`);
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
          if (sttActive && sttSilenceFrames >= STT_SILENCE_FRAMES) {
            const durMs = nowMs() - sttStartedAt;
            sttActive = false;
            sttSpeechFrames = 0;
            sttSilenceFrames = 0;
            if (durMs >= STT_MIN_AUDIO_MS) {
              runSttLlmTtsTurn();
            } else {
              sttMulawChunks = [];
              sttBytes = 0;
            }
          }
          return;
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
              if (suppressInputNow) return;
              
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
        console.log("🛑 Stream stop");
        if (outboundTimer) {
          clearInterval(outboundTimer);
          outboundTimer = null;
        }
        if (openaiWs) openaiWs.close();
      } else {
        console.log("ℹ️ Other event:", msg.event);
      }
    } catch (err) {
      console.error("❌ Invalid message", err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Connection closed. Media frames total:", mediaCount);
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
  });
});

