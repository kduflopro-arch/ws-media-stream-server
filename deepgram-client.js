/**
 * Client Deepgram pour transcription en direct (live streaming).
 * Préparation pour remplacer le STT OpenAI Realtime : audio mulaw 8 kHz (Twilio) → Deepgram → texte.
 *
 * Doc : https://developers.deepgram.com/docs/live-streaming-audio
 * - encoding=mulaw, sample_rate=8000 pour Twilio
 * - interim_results pour barge-in réactif
 * - language=fr par défaut
 * - keyterm (Nova-3) : termes à privilégier (jours, heures, 13h, midi, etc.) — évite "13h" → "trésor"
 * - keywords (Nova-2) : conservé pour rétrocompatibilité
 *
 * Usage prévu (à brancher dans server-core quand USE_DEEPGRAM_STT=true) :
 *   const session = createDeepgramLiveSession({ language: 'fr', keyterm: ['13h', 'dimanche', 'midi', ...] });
 *   session.onTranscript((text, isFinal) => { ... });
 *   session.sendAudio(mulawBuffer);  // à chaque chunk Twilio
 *   session.close();
 *
 * SDK v4 : createClient + listen.live() (LiveTranscriptionEvents).
 */

let createClient;
let LiveTranscriptionEvents;
try {
  const sdk = await import("@deepgram/sdk");
  createClient = sdk.createClient;
  LiveTranscriptionEvents = sdk.LiveTranscriptionEvents;
} catch (e) {
  createClient = null;
  LiveTranscriptionEvents = null;
}

const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY ?? "").trim();

/**
 * Crée une session de transcription live Deepgram.
 * @param {Object} options
 * @param {string} [options.language='fr']
 * @param {string} [options.model='nova-3']
 * @param {string[]} [options.keyterm] - Keyterms Nova-3 (jours, heures, 13h, midi…) — recommandé pour nova-3
 * @param {string[]} [options.keywords] - Mots à privilégier (Nova-2, ignoré si keyterm fourni avec nova-3)
 * @param {boolean} [options.interimResults=true]
 * @param {boolean} [options.smartFormat=true]
 * @returns {{ sendAudio: (buf: Buffer) => void, onTranscript: (cb: (text: string, isFinal: boolean) => void) => void, close: () => void } | null}
 */
export function createDeepgramLiveSession(options = {}) {
  if (!DEEPGRAM_API_KEY) {
    console.warn("[Deepgram] DEEPGRAM_API_KEY manquant, session non créée.");
    return null;
  }
  if (!createClient || !LiveTranscriptionEvents) {
    console.warn("[Deepgram] @deepgram/sdk non installé, session non créée.");
    return null;
  }

  const {
    language = "fr",
    model = process.env.DEEPGRAM_MODEL ?? "nova-3",
    keyterm = [],
    keywords = [],
    interimResults = true,
    smartFormat = true,
  } = options;

  const client = createClient(DEEPGRAM_API_KEY);
  const connectOptions = {
    model,
    language,
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: interimResults,
    smart_format: smartFormat,
    punctuate: true,
  };
  const useNova3 = /nova-3|flux/i.test(String(model));
  if (keyterm.length > 0 && useNova3) {
    connectOptions.keyterm = keyterm.slice(0, 100);
  } else if (keywords.length > 0) {
    connectOptions.keywords = keywords.slice(0, 100).join(", ");
  }

  const connection = client.listen.live(connectOptions);
  const transcriptCbs = [];
  const audioQueue = [];
  let isOpen = false;

  function onTranscript(cb) {
    if (typeof cb === "function") transcriptCbs.push(cb);
  }

  function emitTranscript(text, isFinal) {
    const t = (text || "").trim();
    if (!t) return;
    transcriptCbs.forEach((cb) => {
      try {
        cb(t, isFinal);
      } catch (e) {
        console.error("[Deepgram] onTranscript callback error:", e);
      }
    });
  }

  function flushQueue() {
    if (!isOpen || !connection) return;
    while (audioQueue.length > 0) {
      const buf = audioQueue.shift();
      try {
        connection.send(buf);
      } catch (e) {
        console.error("[Deepgram] send error:", e);
        return;
      }
    }
  }

  function sendAudio(buffer) {
    if (!buffer?.length) return;
    if (isOpen) {
      try {
        connection.send(buffer);
      } catch (e) {
        console.error("[Deepgram] send error:", e);
      }
      return;
    }
    audioQueue.push(Buffer.from(buffer));
  }

  function close() {
    audioQueue.length = 0;
    try {
      if (connection?.disconnect) {
        connection.disconnect();
      }
    } catch (_) {}
    isOpen = false;
  }

  connection.on(LiveTranscriptionEvents.Open, () => {
    isOpen = true;
    const keytermInfo = keyterm.length > 0 ? `, ${keyterm.length} keyterms` : "";
    console.log("[Deepgram] Connexion live ouverte (mulaw 8kHz,", model + ",", language + keytermInfo + ")");
    flushQueue();
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data?.channel?.alternatives?.[0]?.transcript ?? "";
    const isFinal = data?.is_final === true || data?.speech_final === true;
    if (transcript) emitTranscript(transcript, isFinal);
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("[Deepgram] Erreur:", err?.message ?? err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    isOpen = false;
    console.log("[Deepgram] Connexion fermée.");
  });

  return {
    sendAudio,
    onTranscript,
    close,
  };
}

export function isDeepgramAvailable() {
  return !!DEEPGRAM_API_KEY && !!createClient;
}
