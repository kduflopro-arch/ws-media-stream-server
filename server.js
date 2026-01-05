// WebSocket server for Twilio Media Streams + OpenAI Realtime API
// Deploy on Render / Railway / Fly. Not for Vercel (no persistent WS).
// Ports: Render auto-assigns process.env.PORT; locally use 8080.

import http from "http";
import { WebSocketServer, WebSocket } from "ws";

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

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Format audio Realtime côté OpenAI.
// IMPORTANT: en pratique, OpenAI Realtime renvoie très souvent du PCM16 même si on demande g711_ulaw,
// et envoyer du PCM16 à Twilio comme si c'était du μ-law produit un "brouillage" extrêmement fort.
// On sécurise donc par défaut en PCM16.
const OPENAI_AUDIO_FORMAT = (process.env.OPENAI_AUDIO_FORMAT || "pcm16").toLowerCase();

if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY non configuré !");

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

  function nowMs() {
    return Date.now();
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
  // Par défaut activé.
  const INPUT_GATE_ENABLED = (process.env.INPUT_GATE_ENABLED ?? "true").toLowerCase() === "true";
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
          setTimeout(() => {
            try {
              if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
              // Si l'utilisateur a déjà parlé (ou parle), on skip le greeting pour éviter tout chevauchement.
              if (userHasSpoken || speechActive || awaitingUserResponse || responseInProgress) return;
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
Dis: "Oui allô, bonjour !" puis "Garage ${garageName || "AutoGuru"}, c'est le mécano, je vous écoute."
Ensuite: pose UNE question simple ("Qu'est-ce qui vous amène ?")`,
                    },
                  ],
                },
              }));
              requestResponseCreate("greeting");
              console.log("👋 Greeting demandé à OpenAI (response.create).");
            } catch (err) {
              console.error("❌ Erreur envoi greeting à OpenAI:", err);
            }
          }, 600); // laisse le temps au <Say> Twilio de finir
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
          
          // IMPORTANT: selon les versions, le delta audio peut arriver sous:
          // - response.audio.delta
          // - response.output_audio.delta
          if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
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
          
          if (msg.type === "response.audio_transcript.done") {
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
        
        // Connecter à OpenAI Realtime
        connectToOpenAI();

        // Timer d'envoi audio sortant vers Twilio (20ms). Évite les bursts et réduit les artefacts.
        if (!outboundTimer) {
          outboundTimer = setInterval(() => {
            try {
              // Pacing 20ms, avec drainage adaptatif en cas de backlog
              // (Twilio tolère qu'on envoie un peu plus vite, ça réduit la latence sans drop).
              const backlogFrames = Math.floor(outboundQueuedBytes / 160);
              const framesToSend =
                backlogFrames > 600 ? 3 : // >12s
                backlogFrames > 300 ? 2 : // >6s
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
        
        // Audio de Twilio (μ-law 8kHz) → conversion μ-law 8kHz → PCM16 24kHz (OpenAI input_audio_format=pcm16)
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
                speechActive = true;
                lastSpeechTs = nowMs();
                silenceFrames = 0;
              } else if (isSilenceDbg) {
                silenceFrames += 1;
              } else {
                silenceFrames = Math.max(0, silenceFrames - 1);
              }
              if (mediaCount % 200 === 0) {
                console.log("🎚️ VAD (debug):", {
                  avgAbs: Math.round(avgLocal),
                  speechActive,
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
        if (openaiWs) {
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

