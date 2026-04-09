/**
 * Client Deepgram pour transcription en direct (live streaming).
 * Préparation pour remplacer le STT OpenAI Realtime : audio mulaw 8 kHz (Twilio) → Deepgram → texte.
 *
 * Doc : https://developers.deepgram.com/docs/live-streaming-audio
 * - encoding=mulaw, sample_rate=8000 pour Twilio
 * - interim_results pour barge-in réactif
 * - language=fr par défaut
 * - keyterm (Nova-3) : termes à privilégier (jours, heures, 13h, midi, etc.) — évite "13h" → "trésor"
 * - Patrimoine (server-core) : DEEPGRAM_PATRIMOINE_ENDPOINTING_MS, DEEPGRAM_PATRIMOINE_UTTERANCE_END_MS,
 *   DEEPGRAM_PATRIMOINE_MERGE_WINDOW_MS, DEEPGRAM_PATRIMOINE_RESPONSE_DELAY_MS (optionnels)
 * - keywords (Nova-2) : conservé pour rétrocompatibilité
 * - Phrase coupée en 2 : doc "understand-endpointing-interim-results" — concaténer is_final jusqu'à speech_final
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
 * @param {number} [options.endpointing] - ms de silence avant fin d'énoncé (override env / défauts)
 * @param {number} [options.utteranceEndMs] - gap après le dernier mot (min 1000 avec interim_results)
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
    // Activer smart_format améliore généralement la lisibilité STT (nombres, formats),
    // au prix d'un léger coût de latence. Désactivable via DEEPGRAM_SMART_FORMAT=false.
    smartFormat = String(process.env.DEEPGRAM_SMART_FORMAT ?? "true").toLowerCase() === "true",
    endpointing: endpointingOverride,
    utteranceEndMs: utteranceEndMsOverride,
  } = options;

  const client = createClient(DEEPGRAM_API_KEY);
  const isMulti = String(language).toLowerCase() === "multi";
  // Codeswitching FR/EN : Deepgram recommande ~100 ms d'endpointing pour language=multi.
  // En mono, recommandation Deepgram pour téléphonie temps réel : 300 ms.
  const endpointingMono = Number(process.env.DEEPGRAM_ENDPOINTING_MS);
  const endpointingMulti = Number(process.env.DEEPGRAM_ENDPOINTING_MS_MULTI);
  const endpointingDefault = isMulti
    ? (Number.isFinite(endpointingMulti) && endpointingMulti > 0 ? endpointingMulti : 110)
    : (Number.isFinite(endpointingMono) && endpointingMono > 0 ? endpointingMono : 300);
  const endpointing =
    Number.isFinite(endpointingOverride) && endpointingOverride > 0
      ? Math.round(endpointingOverride)
      : endpointingDefault;
  const connectOptions = {
    model,
    language,
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: interimResults,
    smart_format: smartFormat,
    endpointing,
    // no_delay: recommandation Deepgram pour IA conversationnelle — supprime le délai artificiel de précision.
    no_delay: true,
    // filler_words: évite que "euh"/"hmm" déclenche une réponse IA.
    filler_words: false,
    // Utterance end: gap après le dernier mot (min 1000 requis par Deepgram avec interim_results).
    // Légèrement plus long en multi pour laisser finir les phrases en anglais (pauses entre groupes de mots).
    utterance_end_ms: (() => {
      if (Number.isFinite(utteranceEndMsOverride) && utteranceEndMsOverride >= 1000) {
        return Math.round(utteranceEndMsOverride);
      }
      const fromEnv = Number(process.env.DEEPGRAM_UTTERANCE_END_MS);
      if (Number.isFinite(fromEnv) && fromEnv >= 1000) return fromEnv;
      return isMulti ? 1200 : 1000;
    })(),
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
  let keepAliveInterval = null;

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
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
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
    const ue = connectOptions.utterance_end_ms;
    console.log(
      "[Deepgram] Connexion live ouverte (mulaw 8kHz,",
      model + ",",
      language + keytermInfo + ", endpointing=" + endpointing + "ms, utterance_end_ms=" + ue + ")"
    );
    flushQueue();
    // KeepAlive toutes les 4s pour éviter timeout 10s (doc Deepgram : si pas d'audio ni KeepAlive en 10s → NET-0001)
    const KEEPALIVE_MS = Number(process.env.DEEPGRAM_KEEPALIVE_MS) || 4000;
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
      if (!isOpen || !connection) return;
      try {
        if (typeof connection.keepAlive === "function") {
          connection.keepAlive();
        }
      } catch (e) {
        console.error("[Deepgram] keepAlive error:", e?.message ?? e);
      }
    }, KEEPALIVE_MS);
  });

  // Buffer pour concaténer les segments is_final jusqu'à speech_final (doc Deepgram: "concatenate is_final until speech_final").
  let isFinalBuffer = [];
  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = (data?.channel?.alternatives?.[0]?.transcript ?? "").trim();
    const isFinal = data?.is_final === true;
    const speechFinal = data?.speech_final === true;
    if (!transcript) return;
    if (isFinal) isFinalBuffer.push(transcript);
    if (speechFinal) {
      const merged = isFinalBuffer.length > 0
        ? isFinalBuffer.join(" ").replace(/\s+/g, " ").trim()
        : transcript;
      isFinalBuffer = [];
      if (merged) emitTranscript(merged, true);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("[Deepgram] Erreur:", err?.message ?? err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
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

/**
 * Langue STT Deepgram : fr, en, multi (multilingue / code-switching, ex. nova-3 + language=multi).
 * - STT_LANGUAGE=multi ou multilingual → "multi"
 * - STT_LANGUAGE non défini → "fr" (garder la transcription en français par défaut)
 * - Sinon STT_LANGUAGE ou "fr" par défaut
 */
export function resolveDeepgramSttLanguage() {
  const raw = (process.env.STT_LANGUAGE ?? "").trim().toLowerCase();
  if (raw === "multi" || raw === "multilingual") return "multi";
  if (raw.length > 0) return raw;
  return "fr";
}
