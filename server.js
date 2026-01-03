// WebSocket server for Twilio Media Streams + OpenAI Realtime API
// Deploy on Render / Railway / Fly. Not for Vercel (no persistent WS).
// Ports: Render auto-assigns process.env.PORT; locally use 8080.

import { WebSocketServer, WebSocket } from "ws";

// Table de décodage μ-law → PCM16 (8kHz)
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let sign = (i & 0x80) ? -1 : 1;
  let exponent = (i >> 4) & 0x07;
  let mantissa = (i & 0x0F) | 0x10;
  let value = sign * ((mantissa << (exponent + 2)) - (33 << 2));
  MULAW_DECODE_TABLE[i] = value;
}

// Rééchantillonnage simple 8kHz → 24kHz (upsampling linéaire)
function resample8kTo24k(pcm8k) {
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const value = pcm8k[i];
    pcm24k[i * 3] = value;
    pcm24k[i * 3 + 1] = value;
    pcm24k[i * 3 + 2] = value;
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
  const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
  for (let i = 0; i < pcm8k.length; i++) {
    pcm8k[i] = pcm24k[i * 3];
  }
  const mulaw = new Uint8Array(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    let sample = pcm8k[i];
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    sample = sample + 0x84;
    let exponent = 0;
    let exp = sample >> 7;
    if (exp > 0) {
      exponent = 1;
      while (exp > 1) {
        exponent++;
        exp >>= 1;
      }
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa);
  }
  return mulaw;
}

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("⚠️ OPENAI_API_KEY non configuré !");
}

const wss = new WebSocketServer({ port: PORT }, () => {
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
  let speechActive = false;
  let pendingCommit = false;
  // File d'attente audio vers Twilio (μ-law 8kHz). Twilio attend généralement des frames de 20ms = 160 bytes.
  let outboundQueue = []; // Array<Buffer>
  let outboundQueuedBytes = 0;

  function enqueueOutboundMulaw(buf) {
    if (!buf || buf.length === 0) return;
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
      // Configurer le format audio dans l'URL de connexion (PCM16 par défaut 24kHz)
      const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17&input_audio_format=pcm16&output_audio_format=pcm16";
      openaiWs = new WebSocket(openaiUrl, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });

      openaiWs.on("open", () => {
        console.log("✅ Connecté à OpenAI Realtime API");
        
        // Configurer la session OpenAI
        // Note: input_audio_format et output_audio_format sont configurés dans l'URL WebSocket, pas ici
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `Tu es l'assistant vocal intelligent du garage ${garageName || "AutoGuru"}.
Réponds aux appels clients de manière professionnelle, rassurante et concise.
Collecte les informations : plaque d'immatriculation, symptômes, besoin de rendez-vous.
Parle en français, sois naturel et conversationnel.`,
          },
        }));
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
            // Audio de réponse d'OpenAI (PCM16 24kHz) → convertir en μ-law 8kHz pour Twilio
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
              // Décoder base64 → PCM16 24kHz
              const pcm24kBuffer = Buffer.from(audioBase64, "base64");
              const pcm24k = new Int16Array(pcm24kBuffer.buffer, pcm24kBuffer.byteOffset, pcm24kBuffer.length / 2);
              
              // Convertir PCM24k → μ-law 8kHz
              const mulaw = convertPcm24kToMulaw(pcm24k);
              const mulawBuf = Buffer.from(mulaw);
              enqueueOutboundMulaw(mulawBuf);
              
              if (Math.random() < 0.01) {
                console.log("🔊 Audio réponse converti (enqueue) :", {
                  streamSid: twilioStreamSid,
                  deltaLength: audioBase64.length,
                  pcm24kSamples: pcm24k.length,
                  mulawLength: mulawBuf.length,
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

          if (msg.type === "input_audio_buffer.speech_started") {
            speechActive = true;
            pendingCommit = false;
            appendedBytes = 0; // on repart sur un buffer propre pour cette prise de parole
            console.log("🟢 Speech started (OpenAI VAD):", {
              audio_start_ms: msg.audio_start_ms,
              item_id: msg.item_id,
            });
          }

          if (msg.type === "input_audio_buffer.speech_stopped") {
            speechActive = false;
            pendingCommit = true;
            console.log("🔴 Speech stopped (OpenAI VAD):", {
              audio_end_ms: msg.audio_end_ms,
              item_id: msg.item_id,
              appendedBytes,
            });
          }

          if (msg.type === "input_audio_buffer.committed") {
            pendingCommit = false;
            appendedBytes = 0;
            console.log("✅ OpenAI buffer committed:", {
              item_id: msg.item_id,
              previous_item_id: msg.previous_item_id,
            });
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
        
        // Audio de Twilio (μ-law 8kHz) → convertir en PCM16 24kHz pour OpenAI (input_audio_format=pcm16)
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            try {
              const mulawBuffer = Buffer.from(audioBase64, "base64");
              
              if (mediaCount <= 3) {
                console.log(`🔊 Frame ${mediaCount} audio (μ-law):`, {
                  mulawLength: mulawBuffer.length,
                  mulawFirstBytes: Array.from(mulawBuffer.slice(0, 5)),
                  hasPayload: !!audioBase64,
                  payloadLength: audioBase64.length
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
              // On envoie toujours l'audio pour que le VAD serveur OpenAI puisse détecter la parole,
              // mais on ne compte le buffer pour commit que lorsqu'une parole est détectée.
              if (speechActive || pendingCommit) {
                appendedBytes += pcm24kBuffer.length;
              }
              
              // Envoyer PCM24k à OpenAI
              openaiWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: pcm24kBase64,
              }));
              
              // Commit: uniquement après speech_stopped pour éviter les commits de silence.
              // 24kHz PCM16: 150ms = 3600 samples = 7200 bytes
              if (pendingCommit) {
                const hasEnoughAudio = appendedBytes >= 7200;
                if (hasEnoughAudio) {
                  console.log(`📤 Commit buffer (frame ${mediaCount}, bytes=${appendedBytes})`);
                  openaiWs.send(JSON.stringify({
                    type: "input_audio_buffer.commit",
                  }));
                  // On attend l'ack input_audio_buffer.committed pour reset (mais on reset aussi côté compteur ici)
                  appendedBytes = 0;
                  pendingCommit = false;
                } else if (mediaCount % 10 === 0) {
                  console.log(`⏩ Pending commit (bytes=${appendedBytes})`);
                }
              }
            } catch (err) {
              console.error(`❌ Erreur frame ${mediaCount} conversion/envoi audio à OpenAI:`, err);
            }
          } else {
            if (mediaCount <= 3) {
              console.log(`⚠️ Frame ${mediaCount}: pas de payload audio`);
            }
          }
        } else {
          if (mediaCount <= 3) {
            console.log(`⚠️ Frame ${mediaCount}: OpenAI WS pas connecté, état:`, openaiWs?.readyState);
          }
        }

        // Pacer l'audio sortant : on envoie 1 frame (20ms) par frame entrant Twilio (20ms).
        // Cela évite d'envoyer de gros chunks que Twilio pourrait ignorer.
        sendOutboundFrames(1);
        
      } else if (msg.event === "stop") {
        console.log("🛑 Stream stop");
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
    if (openaiWs) {
      openaiWs.close();
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WS error:", err);
  });
});

