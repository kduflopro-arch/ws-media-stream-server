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
    // Répéter chaque échantillon 3 fois (upsampling simple)
    pcm24k[i * 3] = value;
    pcm24k[i * 3 + 1] = value;
    pcm24k[i * 3 + 2] = value;
  }
  return pcm24k;
}

// Convertir μ-law (8kHz) → PCM16 (24kHz)
function convertMulawToPcm24k(mulawBuffer) {
  // Décoder μ-law → PCM16 (8kHz)
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulawBuffer[i] & 0xFF];
  }
  
  // Rééchantillonner 8kHz → 24kHz
  return resample8kTo24k(pcm8k);
}

// Convertir PCM16 (24kHz) → μ-law (8kHz)
function convertPcm24kToMulaw(pcm24k) {
  // Rééchantillonner 24kHz → 8kHz (downsampling simple: prendre 1 échantillon sur 3)
  const pcm8k = new Int16Array(Math.floor(pcm24k.length / 3));
  for (let i = 0; i < pcm8k.length; i++) {
    pcm8k[i] = pcm24k[i * 3];
  }
  
  // Encoder PCM16 → μ-law
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
  let openaiWs = null;

  // Connecter à OpenAI Realtime API
  async function connectToOpenAI() {
    if (!OPENAI_API_KEY) {
      console.error("OpenAI API key manquante");
      return;
    }

    try {
      const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
      openaiWs = new WebSocket(openaiUrl, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });

      openaiWs.on("open", () => {
        console.log("✅ Connecté à OpenAI Realtime API");
        
        // Configurer la session OpenAI
        openaiWs.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: `Tu es l'assistant vocal intelligent du garage ${garageName || "AutoGuru"}.
Réponds aux appels clients de manière professionnelle, rassurante et concise.
Collecte les informations : plaque d'immatriculation, symptômes, besoin de rendez-vous.
Parle en français, sois naturel et conversationnel.`,
            voice: "nova",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: {
              model: "whisper-1",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }));
      });

      openaiWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // Logger tous les types de messages pour debug
          if (msg.type && !msg.type.includes("delta") && !msg.type.includes("transcription")) {
            console.log("📨 OpenAI message:", msg.type, JSON.stringify(msg).substring(0, 200));
          }
          
          if (msg.type === "response.audio_transcript.done") {
            console.log("📝 Transcription IA:", msg.transcript);
          }
          
          if (msg.type === "response.audio.delta") {
            // Audio de réponse d'OpenAI → envoyer à Twilio
            const audioBase64 = msg.delta;
            
            try {
              // Décoder base64 → PCM16 (24kHz)
              const pcm24kBuffer = Buffer.from(audioBase64, "base64");
              const pcm24k = new Int16Array(pcm24kBuffer.buffer, pcm24kBuffer.byteOffset, pcm24kBuffer.length / 2);
              
              // Convertir PCM16 (24kHz) → μ-law (8kHz)
              const mulaw = convertPcm24kToMulaw(pcm24k);
              
              // Encoder μ-law → base64 pour Twilio
              const mulawBase64 = Buffer.from(mulaw).toString("base64");
              
              ws.send(JSON.stringify({
                event: "media",
                streamSid: "default",
                media: {
                  payload: mulawBase64,
                },
              }));
            } catch (err) {
              console.error("❌ Erreur conversion/envoi audio à Twilio:", err);
            }
          }
          
          if (msg.type === "conversation.item.input_audio_transcription.completed") {
            const transcript = msg.transcript;
            console.log("🎤 Client dit:", transcript);
          }
          
          if (msg.type === "error") {
            console.error("❌ Erreur OpenAI:", msg.error);
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
        
        // Extraire les paramètres depuis start.customParameters (passés via TwiML parameters)
        const startParams = msg.start?.customParameters || {};
        const finalCallSid = startParams.callSid || callSid || streamCallSid;
        const finalGarageId = startParams.garageId || garageId;
        const finalGarageName = startParams.garageName || garageName;
        const finalFromNumber = startParams.fromNumber || fromNumber;
        
        console.log("🎬 Stream start:", {
          streamCallSid,
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
        
        // Audio de Twilio → envoyer à OpenAI Realtime
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            try {
              // Décoder base64 → μ-law
              const mulawBuffer = Buffer.from(audioBase64, "base64");
              
              // Convertir μ-law (8kHz) → PCM16 (24kHz)
              const pcm24k = convertMulawToPcm24k(mulawBuffer);
              
              // Encoder PCM16 → base64 pour OpenAI
              const pcm24kBase64 = Buffer.from(pcm24k.buffer).toString("base64");
              
              openaiWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: pcm24kBase64,
              }));
              
              // Déclencher la transcription périodiquement (toutes les 100ms = ~300 frames à 24kHz)
              if (mediaCount % 10 === 0) {
                openaiWs.send(JSON.stringify({
                  type: "input_audio_buffer.commit",
                }));
              }
            } catch (err) {
              console.error("❌ Erreur conversion/envoi audio à OpenAI:", err);
            }
          }
        } else {
          if (mediaCount === 1) {
            console.log("⚠️ OpenAI WS pas encore connecté, état:", openaiWs?.readyState);
          }
        }
        
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

