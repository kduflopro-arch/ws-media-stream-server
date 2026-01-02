// Simple WebSocket server for Twilio Media Streams (skeleton)
// Deploy on Render / Railway / Fly. Not for Vercel (no persistent WS).
// Ports: Render auto-assigns process.env.PORT; locally use 8080.

import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT }, () => {
  console.log(`WS Media Stream server listening on :${PORT}`);
});

wss.on("connection", (ws, req) => {
  console.log("New Media Stream connection:", req.url);
  let mediaCount = 0;

  ws.on("message", (data) => {
    // Twilio Media Streams sends JSON frames: start, media, stop
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        console.log("Stream start:", msg.start?.callSid, msg.start?.streamSid);
      } else if (msg.event === "media") {
        mediaCount += 1;
        if (mediaCount % 200 === 0) {
          console.log(`Media frames: ${mediaCount}`);
        }
        // TODO: envoyer l'audio vers OpenAI Realtime et renvoyer du TTS en temps réel
      } else if (msg.event === "stop") {
        console.log("Stream stop");
      } else {
        console.log("Other event:", msg.event);
      }
    } catch (err) {
      console.error("Invalid message", err);
    }
  });

  ws.on("close", () => {
    console.log("Connection closed. Media frames total:", mediaCount);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

