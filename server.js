// WebSocket server for Twilio Media Streams + OpenAI Realtime API
// Deploy on Render / Railway / Fly. Not for Vercel (no persistent WS).
// Ports: Render auto-assigns process.env.PORT; locally use 8080.

import { WebSocketServer, WebSocket } from "ws";

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
    const urlMatch = req.url.match(/\?([^#]*)/);
    if (urlMatch) {
      const params = new URLSearchParams(urlMatch[1]);
      callSid = params.get("callSid");
      garageId = params.get("garageId");
      garageName = params.get("garageName") || "AutoGuru";
      fromNumber = params.get("fromNumber");
    }
  }
  
  console.log("📞 Paramètres:", { callSid, garageId, garageName, fromNumber });
  
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
            modalities: ["text", "audio"],
            instructions: `Tu es l'assistant vocal intelligent du garage ${garageId || "AutoGuru"}.
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
          
          if (msg.type === "response.audio_transcript.done") {
            console.log("📝 Transcription:", msg.transcript);
          }
          
          if (msg.type === "response.audio.delta") {
            // Audio de réponse d'OpenAI → envoyer à Twilio
            const audioBase64 = msg.delta;
            const audioBuffer = Buffer.from(audioBase64, "base64");
            
            // Convertir PCM16 → μ-law pour Twilio
            // TODO: conversion audio format
            // Pour l'instant, on envoie directement (Twilio accepte PCM16 dans certains cas)
            
            ws.send(JSON.stringify({
              event: "media",
              streamSid: "default",
              media: {
                payload: audioBuffer.toString("base64"),
              },
            }));
          }
          
          if (msg.type === "conversation.item.input_audio_transcription.completed") {
            const transcript = msg.transcript;
            console.log("🎤 Client dit:", transcript);
          }
        } catch (err) {
          console.error("Erreur parsing OpenAI message:", err);
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
        console.log("🎬 Stream start:", { streamCallSid, callSid, garageId });
        
        // Connecter à OpenAI Realtime
        connectToOpenAI();
        
      } else if (msg.event === "media") {
        mediaCount += 1;
        if (mediaCount % 200 === 0) {
          console.log(`📊 Media frames: ${mediaCount}`);
        }
        
        // Audio de Twilio → envoyer à OpenAI Realtime
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            // Convertir μ-law → PCM16 pour OpenAI
            // TODO: conversion audio format
            // Pour l'instant, on envoie directement
            
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: audioBase64,
            }));
            
            // Déclencher la transcription
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.commit",
            }));
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

