/**
 * Serveur WebSocket partagé : garage et restaurant.
 * SECTOR défini par l'entrée (server.js = garage, server_restaurant.js = restaurant).
 */
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Readable } from "stream";
import { createClient } from "@supabase/supabase-js";
import { RESTAURANT_CALL_ANALYSIS_PROMPT, RESTAURANT_CALL_ANALYSIS_SCHEMA, buildRestaurantInstructions } from "./config-restaurant.js";

const PORT = process.env.PORT || 8080;
const ACCOUNT_SECTOR = process.env.ACCOUNT_SECTOR || "garage";
const HOST = process.env.HOST || "0.0.0.0";

/** Helper: libellé de l'établissement pour les salutations (garage vs restaurant).
 * @param {string} name - Nom de l'établissement
 * @param {string} [sector] - Secteur effectif ("restaurant" | "garage"), sinon ACCOUNT_SECTOR
 */
function getPlaceLabelForGreeting(name, sector) {
  const s = (sector || ACCOUNT_SECTOR);
  const raw = String(name || "AutoGuru").trim();
  const nom = /^(garage|restaurant)\s+/i.test(raw) ? raw.replace(/^(garage|restaurant)\s+/i, "").trim() : raw;
  if (s === "restaurant") {
    return /^restaurant\b/i.test(nom) ? nom : `restaurant ${nom}`;
  }
  return /^garage\b/i.test(nom) ? nom : `garage ${nom}`;
}
const CALL_ANALYSIS_PROMPT = `Tu es AutoGuru, assistant d'analyse d'appels garages.
Objectif: produire une analyse JSON fiable, utile au rappel client et à l'accueil atelier.
Règles: ne rien inventer; n'utiliser que ce qui est explicitement dit; sécurité prioritaire.
Résumé (summary): structuré, lisible, utile, sans copier la transcription; inclure prestation, symptômes, demande info/devis/RDV, jour/créneau/plaque si mentionnés.
Conclusion (aiConclusion): 3 à 5 points actionnables (diagnostic probable, urgence, préparation accueil, infos à demander au rappel), sans pourcentage.
Causes probables: 2 à 4 causes avec confidence, jamais "Fallback".
Urgence: low/medium/high selon symptômes réels (danger immédiat => high).
callType: demande_rdv | info | modification_rdv | annulation_rdv (choisir une seule valeur).
Cas critique RDV déjà enregistré rappelé par l'assistant: si le client ne formule aucune demande, ne pas marquer confirmation client ni demande_rdv.
Réponds en français et respecte strictement le schéma JSON fourni.`;
const CALL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    symptoms: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    aiConclusion: { type: "string" },
    probableCauses: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, confidence: { type: "number" } },
        required: ["label", "confidence"],
        additionalProperties: false,
      },
    },
    urgency: { type: "string", enum: ["low", "medium", "high"] },
    appointmentRecommendation: { type: "string" },
    clientInsights: {
      type: "object",
      properties: {
        gender: { type: "string", enum: ["homme", "femme", "indéterminé"] },
        genderConfidence: { type: "number" },
        genderEvidence: { type: "string" },
        ageGroup: { type: "string", enum: ["jeune", "adulte", "senior", "indéterminé"] },
        emotionalState: { type: "string", enum: ["calme", "inquiet", "stressé", "énervé", "confiant", "indéterminé"] },
        notes: { type: "string" },
        vehicleMileage: { type: "string" },
        problemDuration: { type: "string" },
        problemConditions: { type: "string" },
        preferredTimeSlots: { type: "string" },
        constraints: { type: "string" },
        knowledgeLevel: { type: "string", enum: ["débutant", "intermédiaire", "expérimenté", "indéterminé"] },
        communicationStyle: { type: "string", enum: ["direct", "détaillé", "réservé", "bavard", "indéterminé"] },
        urgencyReason: { type: "string" },
        previousGarageExperience: { type: "string" },
      },
      required: ["gender", "genderConfidence", "genderEvidence", "ageGroup", "emotionalState", "notes", "vehicleMileage", "problemDuration", "problemConditions", "preferredTimeSlots", "constraints", "knowledgeLevel", "communicationStyle", "urgencyReason", "previousGarageExperience"],
      additionalProperties: false,
    },
    appointmentConfirmedDate: { type: "string" },
    appointmentConfirmedTime: { type: "string" },
    appointmentConfirmedService: { type: "string" },
    callOutcome: { type: "string" },
    rdvIncompleteReason: { type: "string" },
    callType: { type: "string", enum: ["demande_rdv", "info", "modification_rdv", "annulation_rdv"] },
  },
  required: ["symptoms", "summary", "aiConclusion", "probableCauses", "urgency", "appointmentRecommendation", "clientInsights", "appointmentConfirmedDate", "appointmentConfirmedTime", "appointmentConfirmedService", "callOutcome", "rdvIncompleteReason", "callType"],
  additionalProperties: false,
};
async function handleRunAnalysis(callId, res) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("[run-analysis] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant");
    return send(500, { error: "config", message: "Supabase non configuré" });
  }
  const urlPreview = supabaseUrl.replace(/^https:\/\//, "").slice(0, 40);
  console.log("[run-analysis] Supabase (preview):", urlPreview + "...");
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: call, error: callError } = await supabase
    .schema("autoguru")
    .from("calls")
    .select("id, garage_id, consent, transcript_text, symptom_summary, client_insights, status, call_summary, ai_conclusion, from_number, created_at, service_requested, call_outcome, rdv_incomplete_reason, rdv_requested")
    .eq("id", callId)
    .maybeSingle();
  if (callError) {
    console.error("[run-analysis] Erreur récupération appel:", callError);
    return send(500, { error: "db_error", message: callError.message });
  }
  if (!call) {
    return send(404, { error: "call_not_found" });
  }
  if (call.consent === "denied") {
    await supabase.schema("autoguru").from("calls").update({
      status: "done",
      updated_at: new Date().toISOString(),
    }).eq("id", callId);
    return send(200, { ok: true, message: "consent_denied_no_analysis" });
  }
  const { data: garageRow } = await supabase
    .schema("autoguru")
    .from("garages")
    .select("type")
    .eq("id", call.garage_id)
    .maybeSingle();
  const isRestaurant = garageRow?.type === "restaurant";
  let appointmentMode = "request";
  if (call.garage_id && !isRestaurant) {
    const { data: settings } = await supabase
      .schema("autoguru")
      .from("garage_settings")
      .select("appointment_mode")
      .eq("garage_id", call.garage_id)
      .maybeSingle();
    if (settings?.appointment_mode === "none" || settings?.appointment_mode === "request") {
      appointmentMode = settings.appointment_mode;
    }
  }
  const callDateIso = call.created_at ? new Date(call.created_at).toISOString().slice(0, 10) : null;
  const rdvInstruction = " NE JAMAIS inventer de mot, symptôme, pièce ou prestation que le client n'a pas explicitement dit (ex: si le client a seulement demandé le transfert vers le garage, n'écris pas 'embrayage', 'vidange' ni autre). Pour le résumé (champ summary) : sois DÉTAILLÉ, PRÉCIS et FIDÈLE à l'appel. RÈGLE CRITIQUE - JOUR/CRÉNEAU QUAND L'ASSISTANT CONFIRME : Si dans la transcription l'assistant dit avoir noté ou enregistré la demande pour un jour/créneau (ex. 'Parfait, je note lundi matin', 'J'ai bien noté votre demande pour le mercredi', 'Je note pour samedi', 'C'est une demande de rendez-vous, le garage vous rappellera pour confirmer' après avoir évoqué un jour ou matin/après-midi), alors le client A indiqué un jour/créneau. Tu DOIS écrire dans le résumé ce jour/créneau et remplir appointmentConfirmedDate/appointmentConfirmedTime si tu peux les déduire. Si 'matin' ou 'après-midi' (ou 'l'après-midi') apparaît dans la transcription (dit par le client ou confirmé par l'assistant), le résumé DOIT indiquer le créneau (ex. 'mercredi matin'), jamais 'sans préciser matin ou après-midi'. NE JAMAIS écrire 'le client n'a pas indiqué de jour/créneau préféré' ni 'n'a pas indiqué de jour ou de créneau' si l'assistant a confirmé avoir noté un jour ou un créneau. Si le client souhaite un rendez-vous, écris 'Demande de rendez-vous pour [prestation] — [jour/créneau indiqué ou confirmé par l'assistant], plaque [X] si mentionnée.' RÈGLE : le 'rendez-vous déjà enregistré' que l'assistant mentionne (ex. déjà en dossier) n'est PAS la préférence du client pour cette nouvelle demande. appointmentConfirmedDate et appointmentConfirmedTime = si le client a DIT un jour/créneau OU si l'assistant a confirmé avoir noté un jour/créneau (extrais-le de la confirmation) ; sinon seulement laisse-les vides et écris 'le client n'a pas indiqué de jour/créneau préféré'. RÈGLE NOTIFICATION RDV : Si l'assistant a seulement rappelé au client son RDV déjà enregistré puis demandé \"En quoi puis-je vous aider ?\" et que le client n'a rien demandé ni confirmé (silence, raccrochage) : NE JAMAIS écrire \"Le client a confirmé son accord pour le rendez-vous\" ou \"a confirmé le RDV\". Écris \"L'assistant a rappelé au client son RDV déjà enregistré ([date/heure]). Le client n'a formulé aucune demande ; appel terminé sans autre échange.\" callType = \"info\" dans ce cas (pas \"demande_rdv\"). Mentionne aussi les demandes d'info (tarifs, horaires, prestations) et les réponses du client. Ne jamais écrire 'Un rendez-vous est pris'. Pour le champ callType : mets 'demande_rdv' dès que le client a demandé ou accepté un RDV et a indiqué un jour ou un créneau (matin/après-midi) ; mets 'info' si l'appel est uniquement une demande d'information (horaires, tarifs, etc.) sans prise de RDV ; 'modification_rdv' ou 'annulation_rdv' si le client appelle pour modifier ou annuler un RDV. RÈGLE APPEL NON ABOUTI (rdv_incomplete) : utilise callOutcome = 'rdv_incomplete' UNIQUEMENT si le client a demandé un RDV (ou accepté d'en prendre un) mais a raccroché SANS avoir indiqué ni un jour ni une préférence de créneau (matin/après-midi). Si dans la transcription l'assistant dit des phrases comme « Parfait, jeudi », « Plutôt le matin ou l'après-midi ? » puis plus tard « Je vois que vous êtes déjà dans nos dossiers. Votre plaque... » et « C'est une demande de rendez-vous, le garage vous rappellera pour confirmer », alors le client a indiqué un jour et un créneau : tu DOIS mettre callOutcome = 'completed', rdvIncompleteReason = '' et callType = 'demande_rdv'. De même si l'assistant confirme (ex. 'Je note pour la vidange', 'Parfait pour mercredi matin', 'votre plaque est...', 'Parfait je note pour...'), le client a bien indiqué jour et/ou créneau → callOutcome = 'completed'. Dans ce cas, ne pas écrire dans le résumé que le client a raccroché avant d'indiquer ses préférences. Si le client a seulement demandé des informations (pas de demande de RDV), ou s'il a indiqué un jour/créneau (ou confirmé la plaque pour le RDV), mets callOutcome = 'completed' et rdvIncompleteReason = ''. Réponds en fr.";
  const hasSummary = (call.call_summary ?? "").trim().length > 0;
  const hasConclusion = (call.ai_conclusion ?? "").trim().length > 0;
  const needsAnalysis = call.status === "analyzing" || (call.status === "done" && (!hasSummary || !hasConclusion));
  if (!needsAnalysis) {
    return send(200, { ok: true, message: "call_not_analyzing", status: call.status });
  }
  if (call.status === "done" && (!hasSummary || !hasConclusion)) {
    console.log("[run-analysis] Appel déjà 'done' sans résumé/conclusion, génération de l'analyse:", callId);
  }
  const transcript = (call.transcript_text ?? "").trim();
  if (!transcript) {
    await supabase.schema("autoguru").from("calls").update({
      status: "done",
      updated_at: new Date().toISOString(),
    }).eq("id", callId);
    return send(200, { ok: true, message: "no_transcript" });
  }
  const { data: refetched } = await supabase.schema("autoguru").from("calls").select("status, call_summary, ai_conclusion").eq("id", callId).maybeSingle();
  const alreadyDone = refetched?.status === "done" && (String(refetched?.call_summary ?? "").trim().length > 0) && (String(refetched?.ai_conclusion ?? "").trim().length > 0);
  if (alreadyDone) {
    return send(200, { ok: true, message: "call_already_analyzed", status: "done" });
  }
  const openaiKey = (process.env.OPENAI_API_KEY || "").trim().replace(/\n/g, "").replace(/\r/g, "");
  if (!openaiKey) {
    console.error("[run-analysis] OPENAI_API_KEY manquant");
    return send(500, { error: "config", message: "OPENAI_API_KEY non configuré" });
  }
  const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o";
  const analysisPrompt = isRestaurant ? RESTAURANT_CALL_ANALYSIS_PROMPT : CALL_ANALYSIS_PROMPT;
  const analysisSchema = isRestaurant ? RESTAURANT_CALL_ANALYSIS_SCHEMA : CALL_ANALYSIS_SCHEMA;
  const userInput = isRestaurant
    ? `Transcription: ${transcript}\n${callDateIso ? `Date de l'appel: ${callDateIso}\n` : ""}`
    : `Transcription: ${transcript}\nSymptômes déclarés: ${(call.symptom_summary ?? "non précisé")}\n${callDateIso ? `Date de l'appel (utilise cette année pour les dates du type "mercredi 11 février"): ${callDateIso}\n` : ""}`;
  const systemContent = isRestaurant ? analysisPrompt : `${analysisPrompt} ${rdvInstruction}`;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userInput },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "call_analysis", schema: analysisSchema, strict: true },
        },
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = json?.error?.message || `OpenAI ${resp.status}`;
      console.error("[run-analysis] OpenAI erreur:", callId, msg);
      await supabase.schema("autoguru").from("calls").update({
        status: "done",
        updated_at: new Date().toISOString(),
      }).eq("id", callId);
      return send(500, { error: "analysis_failed", message: msg, statusSetToDone: true });
    }
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[run-analysis] Analyse vide pour appel:", callId);
      return send(500, { error: "analysis_empty" });
    }
    const analysis = JSON.parse(content);
    const summaryText = analysis.summary ?? analysis.Summary ?? null;
    const conclusionText = analysis.aiConclusion ?? analysis.AIConclusion ?? null;
    if (summaryText == null || conclusionText == null) {
      console.warn("[run-analysis] Champs manquants:", { hasSummary: summaryText != null, hasConclusion: conclusionText != null, keys: Object.keys(analysis) });
    } else {
      console.log("[run-analysis] Écriture résumé/conclusion:", { summaryLen: String(summaryText).length, conclusionLen: String(conclusionText).length, isRestaurant });
    }
    let updatePayload;
    if (isRestaurant) {
      const reservationDetails = analysis.reservationDetails && typeof analysis.reservationDetails === "object" ? analysis.reservationDetails : {};
      const existingInsights = (call.client_insights && typeof call.client_insights === "object") ? call.client_insights : {};
      const clientInsights = {
        ...existingInsights,
        ...(typeof analysis.clientInsights === "object" && analysis.clientInsights ? analysis.clientInsights : {}),
        reservationDetails,
      };
      const callOutcomeRest = (analysis.callOutcome ?? "").trim();
      const rdvRequested = (analysis.callType ?? "") === "demande_reservation";
      updatePayload = {
        status: "done",
        updated_at: new Date().toISOString(),
        call_summary: summaryText,
        ai_conclusion: conclusionText,
        client_insights: clientInsights,
        call_outcome: callOutcomeRest || "completed",
        rdv_requested: rdvRequested,
        rdv_incomplete_reason: null,
        symptom_summary: null,
        probable_causes: [],
        urgency_level: null,
      };
    } else {
      const filteredProbableCauses = Array.isArray(analysis.probableCauses)
        ? analysis.probableCauses.filter(
            (c) =>
              c?.label &&
              typeof c.label === "string" &&
              !c.label.toLowerCase().includes("fallback") &&
              c.label.trim().length > 0
          )
        : [];
      const validUrgency =
        analysis.urgency && ["low", "medium", "high"].includes(analysis.urgency)
          ? analysis.urgency
          : null;
      const existingInsights = (call.client_insights && typeof call.client_insights === "object") ? call.client_insights : {};
      const clientInsights = {
        ...existingInsights,
        ...(typeof analysis.clientInsights === "object" && analysis.clientInsights ? analysis.clientInsights : {}),
      };
      const callOutcome = (analysis.callOutcome ?? "").trim();
      const rdvIncompleteReason = (analysis.rdvIncompleteReason ?? "").trim();
      const isRdvIncomplete = callOutcome === "rdv_incomplete" && rdvIncompleteReason;
      const { data: freshCall } = await supabase.schema("autoguru").from("calls").select("call_outcome, rdv_incomplete_reason").eq("id", callId).maybeSingle();
      const noRequestSetByWs = (freshCall?.call_outcome === "no_request");
      const rdvIncompleteSetByWs = (freshCall?.call_outcome === "rdv_incomplete");
      updatePayload = {
        status: "done",
        updated_at: new Date().toISOString(),
        call_summary: summaryText,
        ai_conclusion: conclusionText,
        probable_causes: filteredProbableCauses,
        urgency_level: validUrgency,
        symptom_summary: Array.isArray(analysis.symptoms)
          ? analysis.symptoms.filter(Boolean).slice(0, 8).join(" ; ")
          : null,
        symptoms: Array.isArray(analysis.symptoms) ? analysis.symptoms : null,
        client_insights: clientInsights,
        ...(noRequestSetByWs || rdvIncompleteSetByWs
          ? {}
          : {
              call_outcome: isRdvIncomplete ? "rdv_incomplete" : "completed",
              rdv_incomplete_reason: isRdvIncomplete ? rdvIncompleteReason : null,
            }),
      };
    }
    const { data: updatedRow, error: updateError } = await supabase
      .schema("autoguru")
      .from("calls")
      .update(updatePayload)
      .eq("id", callId)
      .select("id, call_summary, ai_conclusion")
      .single();
    if (updateError) {
      console.error("[run-analysis] Erreur mise à jour:", updateError);
      return send(500, { error: "db_update_failed", message: updateError.message });
    }
    const writtenSummaryLen = (updatedRow?.call_summary ?? "").length;
    const writtenConclusionLen = (updatedRow?.ai_conclusion ?? "").length;
    console.log("[run-analysis] Analyse terminée pour appel:", callId, "| vérif écriture:", { writtenSummaryLen, writtenConclusionLen });
    if (writtenSummaryLen === 0 || writtenConclusionLen === 0) {
      console.warn("[run-analysis] ATTENTION: résumé ou conclusion vides après update (vérifier même projet Supabase que l'app AutoGuru)");
    }
    // Restaurant : création automatique du dossier client pour les prochaines réservations
    if (isRestaurant) {
      const reservationDetails = analysis.reservationDetails && typeof analysis.reservationDetails === "object" ? analysis.reservationDetails : {};
      const clientName = (reservationDetails.clientName ?? "").trim();
      const fromNumber = (call.from_number ?? "").trim();
      if (clientName && fromNumber && call.garage_id) {
        const ingestUrl = process.env.AUTOGURU_INGEST_URL || "";
        const baseUrl = ingestUrl ? ingestUrl.replace(/\/api\/twilio\/realtime-(?:ingest|finalize)\/?$/i, "").replace(/\/+$/, "") : (process.env.AUTOGURU_API_BASE || "").replace(/\/+$/, "");
        const secret = process.env.RUN_ANALYSIS_SECRET || "";
        if (baseUrl && secret) {
          const createClientUrl = `${baseUrl.replace(/\/$/, "")}/api/internal/create-restaurant-client`;
          fetch(createClientUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ garage_id: call.garage_id, phone_number: fromNumber, name: clientName }),
          }).then((r) => {
            if (r.ok) console.log("[run-analysis] Dossier client restaurant créé/mis à jour:", clientName);
            else r.text().then((t) => console.warn("[run-analysis] create-restaurant-client échec:", r.status, t));
          }).catch((e) => console.warn("[run-analysis] create-restaurant-client erreur:", e.message));
        }
      }
    }
    return send(200, { ok: true, callId, status: "done" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[run-analysis] Erreur analyse:", callId, msg);
    try {
      await supabase.schema("autoguru").from("calls").update({
        status: "done",
        updated_at: new Date().toISOString(),
      }).eq("id", callId);
    } catch (e) {
      console.error("[run-analysis] Fallback status done échoué:", e);
    }
    return send(500, { error: "analysis_failed", message: msg, statusSetToDone: true });
  }
}
const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0].trim();
  const pathnameLower = pathname.toLowerCase();
  if (pathnameLower === "/health" || pathnameLower === "/health/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && pathnameLower.startsWith("/run-analysis/")) {
    const callId = pathname.slice("/run-analysis/".length).trim().replace(/\/.*$/, "");
    const authHeader = req.headers.authorization || "";
    const runAnalysisSecret = process.env.RUN_ANALYSIS_SECRET;
    const expected = runAnalysisSecret ? `Bearer ${runAnalysisSecret}` : "";
    if (!expected || authHeader !== expected) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (!callId) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing id" }));
      return;
    }
    handleRunAnalysis(callId, res);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ws server");
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
const LOG_VERBOSE = (process.env.LOG_LEVEL || "minimal").toLowerCase() === "verbose";
const PIPELINE_MODE_RAW = String(process.env.PIPELINE_MODE ?? "realtime").toLowerCase().trim();
const PIPELINE_MODE =
  PIPELINE_MODE_RAW === "stt_llm_tts"
    ? "stt_llm_tts"
    : PIPELINE_MODE_RAW.includes("realtime")
      ? "realtime"
      : "realtime";
const INIT_DELAY_MS = Number(process.env.RENDER_INIT_DELAY_MS ?? "5000");
server.listen(PORT, HOST, () => {
  console.log(`WS Media Stream server listening on ${HOST}:${PORT}`);
  console.log(`[Render] Health check: GET http://0.0.0.0:${PORT}/health (init dans ${INIT_DELAY_MS}ms)`);
  setTimeout(runRest, INIT_DELAY_MS);
});
function runRest() {
  console.log("[Render] Init lourde (WebSocket, TTS…) en cours…");
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
   if (greetedCallSidCache.size > 500) {
     const firstKey = greetedCallSidCache.keys().next().value;
     if (firstKey) greetedCallSidCache.delete(firstKey);
   }
 }
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let uval = (~i) & 0xff;
  let t = ((uval & 0x0f) << 3) + 0x84;
  t <<= (uval & 0x70) >> 4;
  MULAW_DECODE_TABLE[i] = (uval & 0x80) ? (0x84 - t) : (t - 0x84);
}
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
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
  let seg = 0;
  while (seg < 8 && sample > MULAW_SEG_END[seg]) seg++;
  if (seg > 7) seg = 7;
  const mantissa = (sample >> (seg + 3)) & 0x0f;
  const uval = sign | (seg << 4) | mantissa;
  return (~uval) & 0xff;
}
function resample8kTo24k(pcm8k) {
  const pcm24k = new Int16Array(pcm8k.length * 3);
  for (let i = 0; i < pcm8k.length; i++) {
    const s0 = pcm8k[i];
    const s1 = i + 1 < pcm8k.length ? pcm8k[i + 1] : s0;
    pcm24k[i * 3] = s0;
    pcm24k[i * 3 + 1] = (2 * s0 + s1) / 3;
    pcm24k[i * 3 + 2] = (s0 + 2 * s1) / 3;
  }
  return pcm24k;
}
function convertMulawToPcm24k(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = MULAW_DECODE_TABLE[mulawBuffer[i] & 0xFF];
  }
  return resample8kTo24k(pcm8k);
}
function convertPcm24kToMulaw(pcm24k) {
  const outLen = Math.floor(pcm24k.length / 3);
  const mulaw = new Uint8Array(outLen);
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
function convertPcm32kToMulaw(pcm32k) {
  const outLen = Math.floor(pcm32k.length / 4);
  const mulaw = new Uint8Array(outLen);
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
function convertPcm8kToMulaw(pcm8k) {
  const mulaw = new Uint8Array(pcm8k.length);
  const outputGain = Number(process.env.OUTPUT_GAIN ?? "1.0");
  for (let i = 0; i < pcm8k.length; i++) {
    const gained = clamp16((pcm8k[i] * outputGain) | 0);
    mulaw[i] = mulawEncodeSample(gained);
  }
  return mulaw;
}
function convertPcm16kBlockToMulaw(pcm16kBlockBuf) {
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_AUDIO_FORMAT = (process.env.OPENAI_AUDIO_FORMAT || "pcm16").toLowerCase();
if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY non configuré !");
  function runRestPart2() {
  console.log("[Render] Init partie 2 (WebSocket) en cours…");
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
});
const deferredFinalizeTimersByCallSid = new Map(); // callSid -> timerId
const latestStreamStartTimeByCallSid = new Map(); // callSid -> callStartTimeMs
wss.on("connection", (ws, req) => {
  if (LOG_VERBOSE) {
    console.log("📞 New Media Stream connection:", req.url);
    console.log("📞 Headers:", JSON.stringify(req.headers, null, 2).substring(0, 500));
  } else {
    console.log("📞 Connection:", req.url?.split("?")[0] || "/");
  }
  let callSid = null;
  let garageId = null;
  let garageName = "AutoGuru";
  let fromNumber = null;
  if (req.url) {
    if (LOG_VERBOSE) console.log("🔍 URL complète:", req.url);
    const urlMatch = req.url.match(/\?([^#]*)/);
    if (urlMatch) {
      const queryString = urlMatch[1];
      if (LOG_VERBOSE) console.log("🔍 Query string:", queryString);
      const params = new URLSearchParams(queryString);
      callSid = params.get("callSid");
      garageId = params.get("garageId");
      garageName = params.get("garageName") || "AutoGuru";
      fromNumber = params.get("fromNumber");
    } else {
      if (LOG_VERBOSE) console.log("⚠️ Pas de query string dans l'URL");
    }
  } else {
    if (LOG_VERBOSE) console.log("⚠️ req.url est null");
  }
  if (LOG_VERBOSE) console.log("📞 Paramètres extraits:", { callSid, garageId, garageName, fromNumber });
  let effectiveSector = ACCOUNT_SECTOR; // Surchargé par garageType des params (restaurant vs garage)
  let goodbyeDetected = false;
  let goodbyeTimer = null;
  let deferredFinalizeTimer = null; // fallback finalize si on a différé (client raccroche sans 2e stream)
  let lastUserActivityMs = 0;
  let callStartTimeMs = nowMs(); // Initialiser le temps de début d'appel
  lastUserActivityMs = callStartTimeMs; // Si le client ne parle jamais, timeSinceLastUserActivity = callDurationMs (évite valeur énorme)
  const GOODBYE_DELAY_MS = 2000; // 2 s après l'au revoir pour couper l'appel
  const GOODBYE_POST_AUDIO_DELAY_MS = Number(process.env.GOODBYE_POST_AUDIO_DELAY_MS) || 1000; // 1 s après queue vide (raccrocher dès que Minimax a fini de parler)
  const GOODBYE_MAX_WAIT_MS = Number(process.env.GOODBYE_MAX_WAIT_MS) || 20000; // Secours : raccrocher au plus tard 20 s après "au revoir" si la queue ne se vide pas
  const MIN_CALL_DURATION_MS = 30000; // Minimum 30 secondes d'appel avant hangup automatique (inactivité sans au revoir)
  const MIN_CALL_DURATION_FOR_GOODBYE_MS = Number(process.env.MIN_CALL_DURATION_FOR_GOODBYE_MS) || 10000; // Si l'IA a dit "au revoir", on peut raccrocher après 10 s (appels courts)
  const MIN_USER_INACTIVITY_MS = 5000; // Client doit être inactif depuis au moins 5 secondes
  let goodbyeFallbackTimer = null; // Timer de secours : hangup forcé si queue audio ne se vide pas après "au revoir"
  let mediaCount = 0;
  let appendedBytes = 0; // bytes ajoutés depuis le dernier commit
  let openaiWs = null;
  let twilioStreamSid = null;
  let speechActive = false;
  let lastSpeechTs = 0;
  let lastCommitAt = 0; // Dernier input_audio_buffer.committed (pour watchdog response.create)
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
  let preOpenFrames = []; // Array<{ audioBase64: string, mulawLen: number, ts: number }>
  let preOpenBytes = 0;
  let outboundQueue = []; // Array<Buffer>
  let outboundQueuedBytes = 0;
  let hasSentInitialGreeting = false;
  let initialAssistantGreetingText = "";
  let rdvNotificationFollowupPlayed = false; // une seule fois par appel pour ne pas rejouer "Je vois que vous avez un RDV..." en plein flux
  let loggedFirstAudioDelta = false;
  let outboundTimer = null;
  let lastResponseAt = 0;
  let awaitingUserResponse = false;
  let droppedOutboundBytes = 0;
  let rateLimitRetryCount = 0;
  let localDbgSpeechActive = false;
  const OUTPUT_WAIT_FOR_USER_SILENCE = (process.env.OUTPUT_WAIT_FOR_USER_SILENCE ?? "true").toLowerCase() === "true";
  const OUTPUT_USER_SPEECH_THRESHOLD = Number(process.env.OUTPUT_USER_SPEECH_THRESHOLD ?? "2800");
  const OUTPUT_USER_SPEECH_FRAMES = Number(process.env.OUTPUT_USER_SPEECH_FRAMES ?? "6"); // ~120ms
  const OUTPUT_USER_SILENCE_THRESHOLD = Number(process.env.OUTPUT_USER_SILENCE_THRESHOLD ?? "1100");
  const OUTPUT_USER_SILENCE_FRAMES = Number(process.env.OUTPUT_USER_SILENCE_FRAMES ?? "18"); // ~360ms
  const ASSISTANT_RESPONSE_WINDOW_MS = Number(process.env.ASSISTANT_RESPONSE_WINDOW_MS ?? "20000"); // Augmenté à 20s pour être plus permissif
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
  const REALTIME_USER_STT_ENABLED = (process.env.REALTIME_USER_STT_ENABLED ?? "true").toLowerCase() === "true";
  const REALTIME_USER_STT_SPEECH_THRESHOLD = Number(process.env.REALTIME_USER_STT_SPEECH_THRESHOLD ?? "1500");
  const REALTIME_USER_STT_SPEECH_FRAMES = Number(process.env.REALTIME_USER_STT_SPEECH_FRAMES ?? "6");
  const REALTIME_USER_STT_SILENCE_THRESHOLD = Number(process.env.REALTIME_USER_STT_SILENCE_THRESHOLD ?? "650");
  const REALTIME_USER_STT_SILENCE_FRAMES = Number(process.env.REALTIME_USER_STT_SILENCE_FRAMES ?? "32"); // ~640ms: laisser le client finir sa phrase avant de répondre
  const REALTIME_USER_STT_MIN_AUDIO_MS = Number(process.env.REALTIME_USER_STT_MIN_AUDIO_MS ?? "500");
  let rtSttSpeechFrames = 0;
  let rtSttSilenceFrames = 0;
  let rtSttActive = false;
  let rtSttStartedAt = 0;
  let rtSttMulawChunks = [];
  let rtSttInFlight = false;
  const PREMIUM_TTS_ENABLED = (process.env.PREMIUM_TTS_ENABLED ?? "false").toLowerCase() === "true";
  const PREMIUM_TTS_PROVIDER = (process.env.PREMIUM_TTS_PROVIDER ?? "elevenlabs").toLowerCase();
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
  const ELEVENLABS_VOICE_ID_DEFAULT = process.env.ELEVENLABS_VOICE_ID ?? "";
  const ELEVENLABS_VOICE_ID_MALE = process.env.ELEVENLABS_VOICE_ID_MALE ?? "";
  const ELEVENLABS_VOICE_ID_FEMALE = process.env.ELEVENLABS_VOICE_ID_FEMALE ?? "";
  const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
  const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT ?? "pcm_16000";
  const ELEVENLABS_OPTIMIZE_STREAMING_LATENCY = Number(process.env.ELEVENLABS_OPTIMIZE_STREAMING_LATENCY ?? "3"); // 0..4
  const ELEVENLABS_STABILITY = Number(process.env.ELEVENLABS_STABILITY ?? "0.55"); // 0..1
  const ELEVENLABS_SIMILARITY_BOOST = Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? "0.85"); // 0..1
  const ELEVENLABS_STYLE = Number(process.env.ELEVENLABS_STYLE ?? "0.35"); // 0..1
  const ELEVENLABS_USE_SPEAKER_BOOST = (process.env.ELEVENLABS_USE_SPEAKER_BOOST ?? "true").toLowerCase() === "true";
  const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? "";
  const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID ?? "";
  const MINIMAX_USE_BALANCE = (process.env.MINIMAX_USE_BALANCE ?? "true").toLowerCase() === "true"; // true = facturation sur le solde (pas de GroupId), false = utiliser MINIMAX_GROUP_ID si défini
  const MINIMAX_VOICE_ID_DEFAULT = process.env.MINIMAX_VOICE_ID ?? "";
  const MINIMAX_VOICE_ID_MALE = process.env.MINIMAX_VOICE_ID_MALE ?? "";
  const MINIMAX_VOICE_ID_FEMALE = process.env.MINIMAX_VOICE_ID_FEMALE ?? "";
  const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "speech-01"; // speech-01, speech-02, etc.
  const MINIMAX_SPEED = Number(process.env.MINIMAX_SPEED ?? "1"); // 0.5 à 2.0
  const MINIMAX_VOLUME = Number(process.env.MINIMAX_VOLUME ?? "1.0"); // 0.0 à 1.0
  const MINIMAX_PITCH = Number(process.env.MINIMAX_PITCH ?? "0"); // -12 à 12
  let premiumTtsAbort = null;
  let premiumTtsBypassUntilMs = 0; // si TTS premium échoue, on laisse passer l'audio OpenAI un moment
  let premiumTtsInFlight = false;
  let premiumTtsLastError = null;
  let premiumTtsQueue = []; // Array<{ text: string, interrupt: boolean }>
  let premiumTtsDrainInFlight = false;
  let premiumTtsLastText = ""; // Dernier texte effectivement envoyé au TTS (pour éviter les répétitions exactes)
  let lastGarageToolOutputAt = 0; // Après envoi function_call_output (get_garage_pricing, etc.) : laisser finir "Un instant" avant la suite
  let pendingGaragePricingResponseAt = 0; // Timestamp quand on attend une réponse IA après get_garage_pricing (pour fallback si vide)
  let pendingGaragePricingRetryDone = false; // Éviter boucle infinie
  let lastGaragePricingFallbackPhrase = ""; // Phrase TTS de secours si le modèle ne répond pas
  let spokenResponseIds = new Map(); // responseId -> timestamp (anti-répétitions par réponse)
  let recentAssistantTexts = []; // Array<{ text: string, ts: number }>
  const minimaxBillingMode = MINIMAX_USE_BALANCE ? "solde (pay-as-you-go)" : (MINIMAX_GROUP_ID ? "abonnement (GroupId)" : "solde (défaut)");
  if (LOG_VERBOSE) {
    console.log("🔧 PREMIUM TTS config:", { provider: PREMIUM_TTS_PROVIDER, hasMinimaxKey: !!MINIMAX_API_KEY, minimaxBilling: minimaxBillingMode });
  }
  const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS ?? "520");
  const AUTOGURU_INGEST_URL_ENV = process.env.AUTOGURU_INGEST_URL ?? ""; // ex: https://<autoguru>/api/twilio/realtime-ingest
  const AUTOGURU_INGEST_SECRET_ENV = process.env.AUTOGURU_INGEST_SECRET ?? "";
  const RUN_ANALYSIS_SECRET_ENV = process.env.RUN_ANALYSIS_SECRET ?? ""; // même valeur que sur AutoGuru (Vercel)
  /** En-têtes pour les appels vers l'API AutoGuru (Vercel), dont TTS et run-analysis (Bearer). */
  function autoguruApiHeaders(overrides = {}) {
    const h = { "Content-Type": "application/json", ...overrides };
    if (RUN_ANALYSIS_SECRET_ENV) h["Authorization"] = "Bearer " + RUN_ANALYSIS_SECRET_ENV;
    return h;
  }
  let autoguruIngestUrl = "";
  let autoguruIngestToken = "";
  let callToken = ""; // Twilio CallToken (appel entrant) → transfert affiche le numéro client au garage
  let clientInfo = null; // Infos client (nom, rendez-vous à venir)
  let assistantName = "Sandra";
  let assistantVoice = "female"; // "female" | "male"
  let garageTone = "";
  let consentRequired = true;
  let consentGiven = false; // Track si le consentement a déjà été donné
  let lastUserTextForConsent = null; // Dernier texte client avant réponse IA (pour forcer rappel consentement si ni oui ni non)
  let lastAssistantText = ""; // Dernier message assistant (pour ne pas confondre refus rappel avec refus consentement)
  let recentAssistantQuestionIntents = []; // Array<{ intent: "callback"|"rdv"; ts: number }>
  let hasAskedDayOrSlot = false;
  let callbackRefusedByClient = false; // Client a refusé d'être rappelé (envoyé au finalize pour badge "Pas rappel")
  let callbackAcceptedByClient = false; // Client a accepté explicitement d'être rappelé
  let rdvRefusedByClient = false; // Client a refusé de prendre rendez-vous (envoyé au finalize → rdv_requested false)
  let rdvAcceptedByClient = false; // Client a accepté explicitement la prise de rendez-vous (badge RDV)
  let devisAcceptedByClient = false; // Client a accepté une demande de devis (envoyé au finalize → badge "Devis demandé")
  let validationDevisByClient = false; // Client appelle pour valider un devis déjà établi (urgence maximale, carte dorée)
  let modificationRdvByClient = false; // Client a demandé à modifier un RDV (badge Modif. RDV)
  let annulationRdvByClient = false; // Client a demandé à annuler un RDV (badge Annul. RDV)
  let transferToGarageStatus = null; // 'success' | 'failure' | null — mis par webhooks Twilio (transfer-join human = success, transfer-garage-status = failure)
  let transferTriggered = false; // true si on a appelé call-transfer avec succès → envoyer transfer_to_garage: true au finalize
  let transferFailed = false; // true si reconnexion après transfert raté (garage n'a pas répondu) — utilisé dans connectToOpenAI
  let lastUserTextPendingIngest = null; // Parole client à enregistrer uniquement quand l'IA a répondu (ingest au prochain conversation.item.done assistant)
  let lastUserMessageText = ""; // Dernier texte client (pour safeguard hangup : ne pas raccrocher si demande devis/RDV)
  let callbackAckSpoken = false; // éviter de répéter "Ok je note..." si la transcription se répète
  let userSpeakCount = 0; // Nombre de fois que le client a parlé (conversation.item.done user) → si < 1 au finalize = no_request
  let assistantTurnCount = 0; // Nombre de réponses IA (response.done avec texte) ; si >= 2 on considère que le client a parlé (secours si userSpeakCount reste 0)
  const assistantTurnRids = new Set(); // Éviter double comptage par response_id
  const userSpeakItemIds = new Set(); // Éviter double comptage du même item
  const CONSENT_MAIN = "Pour continuer, dites : Oui je suis d'accord. Sinon raccrochez si vous refusez.";
  const CONSENT_REMINDER = "Pour continuer, dites : Oui je suis d'accord. Sinon raccrochez si vous refusez.";
  function playPostConsentGreeting() {
    if (ws.__postConsentGreetingPlayed || !PREMIUM_TTS_ENABLED) return;
    const placePart = getPlaceLabelForGreeting(garageName, effectiveSector);
    const isResto = effectiveSector === "restaurant";
    let phrase;
    if (isResto) {
      const rawName = String(garageName || "").trim();
      const label = /^restaurant\b/i.test(rawName) ? rawName : `restaurant ${rawName}`;
      if (clientInfo?.name) {
        const parts = clientInfo.name.split(/\s+/).filter(p => p.trim().length > 0);
        const ln = clientInfo.last_name?.trim() || parts[parts.length - 1] || clientInfo.name;
        const tt = clientInfo.gender === "homme" ? "Monsieur" : clientInfo.gender === "femme" ? "Madame" : "";
        phrase = `Bonjour ${tt ? tt + " " + ln : ln}. ${assistantName} du ${label}, je vous écoute.`;
      } else {
        phrase = `${label}, ${assistantName} à l'appareil. Je vous écoute.`;
      }
      const apt = (clientInfo?.appointments || []).find(a => !a.en_attente_confirmation_garage);
      if (apt) {
        const d = new Date(apt.appointment_date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        const t = (apt.appointment_time || "").slice(0, 5);
        phrase = phrase.replace("Je vous écoute.", `Je vois que vous avez une réservation pour le ${d} à ${t}. Je vous écoute.`);
      }
    } else {
      phrase = `Bonjour. Ici ${assistantName} du ${placePart}. En quoi puis-je vous aider ?`;
      if (clientInfo?.name) {
        const parts = clientInfo.name.split(/\s+/).filter(p => p.trim().length > 0);
        const ln = clientInfo.last_name?.trim() || parts[parts.length - 1] || clientInfo.name;
        const tt = clientInfo.gender === "homme" ? "Monsieur" : clientInfo.gender === "femme" ? "Madame" : "";
        phrase = `Bonjour ${tt ? tt + " " + ln : ln}. En quoi puis-je vous aider ?`;
      }
      const apt = (clientInfo?.appointments || []).find(a => !a.en_attente_confirmation_garage);
      if (apt) {
        const d = new Date(apt.appointment_date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        const t = (apt.appointment_time || "").slice(0, 5);
        phrase = phrase.replace("En quoi puis-je vous aider ?", `Je vois que vous avez un rendez-vous enregistré pour le ${d} à ${t}. En quoi puis-je vous aider ?`);
      }
    }
    ws.__postConsentGreetingPlayed = true;
    enqueuePremiumTts(phrase, { interrupt: true, source: "post_consent_greeting", allowWithoutUser: true });
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text: phrase }] },
        }));
      } catch (e) { /* ignore */ }
    }
    console.log("👋 Post-consent greeting joué.", { hasClientName: !!clientInfo?.name, sector: effectiveSector });
  }
  let appointmentMode = "request";
  let garageClosed = false;
  let garageClosedReason = "";
  let garageClosedText = "";
  let lunchFullToday = false; // Complet midi : IA dit "nous sommes complets" pour résa midi jour même
  let dinnerFullToday = false; // Complet soir : IA dit "nous sommes complets" pour résa soir jour même
  let callStartIso = "";
  let garageHoursText = "";
  let availableAppointmentSlotsLine = "";
  let closedDaysText = ""; // Jours de fermeture hebdomadaires (ex: "Le garage est fermé le dimanche")
  let allowTransfer = true; // false = transfert vers le garage désactivé → proposer rappel si client appelle pour une info
  let collectVehicleInfo = false;
  let pricingSummary = "";
  let servicesSummary = "";
  let servicesRequiringStockSummary = "";
  let servicesIncludesSummary = "";
  let faqsSummary = "";
  let menuSummary = "";
  let ingestSeq = 0;
  let ingestChain = Promise.resolve();
  function recordAssistantQuestionIntent(text) {
    const raw = String(text || "");
    if (!raw) return;
    const rawLower = raw.toLowerCase();
    const questions = raw.match(/[^?.!\n\r]*\?/g) || [];
    const target = String(questions.length ? questions[questions.length - 1] : raw).toLowerCase();
    const asksCallback = /\b(rappel|rappeler|rappelé|recontact|recontacter)\b/.test(target) && (target.includes("souhaitez") || target.includes("voulez") || target.includes("?"));
    const asksRdv = (/\b(rendez-?vous|rdv|créneau)\b/.test(target) || /quel\s*jour|jour\s*vous\s*convient|matin|après-?midi/.test(target)) && (target.includes("souhaitez") || target.includes("voulez") || target.includes("?"));
    const asksDevisLast = /\b(devis)\b/.test(target) && (target.includes("souhaitez") || target.includes("voulez") || target.includes("demande")) && target.includes("?");
    const asksDevisAnywhere = /\b(devis)\b/.test(rawLower) && (rawLower.includes("souhaitez") || rawLower.includes("voulez") || rawLower.includes("demande")) && (rawLower.includes("demande de devis") || rawLower.includes("faire une demande"));
    const asksDevisEtablir = /\bdevis\b/.test(rawLower) && (rawLower.includes("établir") || rawLower.includes("etablir")) && (rawLower.includes("plaque") || rawLower.includes("immatriculation"));
    const asksDevis = asksDevisLast || asksDevisAnywhere || asksDevisEtablir;
    const intent = asksDevis ? "devis" : asksCallback && !asksRdv ? "callback" : asksRdv && !asksCallback ? "rdv" : null;
    if (!intent) return;
    if (intent === "rdv" && /\b(quel\s*jour|jour\s*vous|matin|après-?midi|plutôt)\b/i.test(target)) hasAskedDayOrSlot = true;
    recentAssistantQuestionIntents.push({ intent, ts: nowMs() });
    console.log("📌 [RDV] recordAssistantQuestionIntent:", { intent, asksRdv: !!asksRdv, asksCallback: !!asksCallback, asksDevis: !!asksDevis, lastQuestion: target.slice(0, 80) });
    if (recentAssistantQuestionIntents.length > 10) {
      recentAssistantQuestionIntents = recentAssistantQuestionIntents.slice(-10);
    }
  }
  function getMostRecentAssistantIntent(maxAgeMs = 25000) {
    const now = nowMs();
    for (let i = recentAssistantQuestionIntents.length - 1; i >= 0; i--) {
      const it = recentAssistantQuestionIntents[i];
      if (now - (it?.ts ?? 0) <= maxAgeMs) return it.intent;
      break;
    }
    return "unknown";
  }
  /** Retourne true si le message assistant indique une modification de RDV (demande pour modifier, nouvelle date, déplacer). */
  function isAssistantModificationRdv(assistantText) {
    const t = String(assistantText || "").toLowerCase();
    if (/\b(modifier|modification)\s+(ce|votre|son)\s+(rdv|rendez-?vous)\b/i.test(t)) return true;
    if (/\bdemande\s+pour\s+modifier\b/i.test(t) || /\bfaire\s+une\s+demande\s+pour\s+modifier\b/i.test(t)) return true;
    if (/\bnouvelle\s+date\s+et\s+créneau\b/i.test(t) || /\bnouvelle\s+date\s+et\s+heure\b/i.test(t)) return true;
    if (/\bdéplacer\s+(ce|votre)\s+(rdv|rendez-?vous)\b/i.test(t) || /\bsouhaitez-?vous\s+le\s+déplacer\b/i.test(t)) return true;
    if (/\bconfirmer\s+la\s+nouvelle\s+date\b/i.test(t) || /\brappellera\s+pour\s+confirmer\s+la\s+nouvelle\b/i.test(t)) return true;
    if (/\bje\s+note\s+une\s+demande\s+pour\s+.+\s+à\s+\d+\s*heures?\b/i.test(t) && (t.includes("modifier") || t.includes("nouvelle date") || t.includes("déplacer"))) return true;
    return false;
  }
  /** Retourne true si l'assistant confirme avoir noté une modification de RDV (phrase de confirmation présente, même si le message se termine par une question). */
  function isAssistantConfirmingModificationRdv(assistantText) {
    const t = String(assistantText || "").toLowerCase().trim();
    if (/\b(noté|note)\s+(votre\s+)?(demande\s+de\s+)?modification\b/i.test(t)) return true;
    if (/\b(bien\s+noté|j'?ai\s+bien\s+noté)\b.*\bmodification\b/i.test(t)) return true;
    if (/\bdemande\s+de\s+modification\s+(pour|au)\b/i.test(t) && (/\bnoté\b/.test(t) || /\b(rappellera|rappel)\b/.test(t))) return true;
    if (/\brappellera\s+pour\s+confirmer\s+(la\s+)?nouvelle\s+(date|heure)\b/i.test(t)) return true;
    return false;
  }
  /** Retourne true si l'assistant confirme avoir noté une annulation de RDV (phrase de confirmation présente, même si le message se termine par une question). */
  function isAssistantConfirmingAnnulationRdv(assistantText) {
    const t = String(assistantText || "").toLowerCase().trim();
    if (/\b(noté|note)\s+(votre\s+)?(demande\s+)?d\W*annulation\b/i.test(t)) return true;
    if (/\b(bien\s+noté|j'?ai\s+bien\s+noté)\b.*\bannulation\b/i.test(t)) return true;
    if (/\bdemande\s+d\W*annulation\s+(pour|du)\b/i.test(t) && (/\bnoté\b/.test(t) || /\bnote\b/.test(t))) return true;
    if (/\bannulation\b/.test(t) && (/\bje\s+note\b/.test(t) || /\bnoté\b/.test(t) || /\bdemande\s+d\W*annulation\b/.test(t))) return true;
    return false;
  }
  /** Retourne true si le message assistant indique une annulation de RDV. */
  function isAssistantAnnulationRdv(assistantText) {
    const t = String(assistantText || "").toLowerCase();
    if (/\b(annuler|annulation)\s+(ce|votre|son)\s+(rdv|rendez-?vous)\b/i.test(t)) return true;
    if (/\bdemande\s+d\W*annulation\b/i.test(t) || /\bnoté.*annulation\b/i.test(t)) return true;
    if (/(?:je\s+)?note\s+(?:votre\s+)?(?:demande\s+)?d\W*annulation/i.test(t)) return true;
    if (/\bannulation\b/.test(t) && (t.includes("je note") || t.includes("noté") || t.includes("demande d"))) return true;
    return false;
  }
  /** Retourne true si le message assistant indique qu'une demande de RDV a été notée (jour/créneau ou confirmation finale). */
  function isAssistantConfirmingRdv(assistantText) {
    const t = String(assistantText || "").toLowerCase();
    if (/\b(demande\s+de\s+devis|demande\s+devis|pour\s+(le\s+)?devis)\b/i.test(t)) return false;
    if (/\b(je\s+)?note\s+pour\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|après-demain)\b/i.test(t)) return true;
    if (/\bje\s+note\s+(pour\s+)?(le\s+)?(matin|après-midi)\b/i.test(t)) return true;
    if (/\b(parfait\s*,?\s*)?c'?est\s+noté\b/i.test(t) && (/\b(rdv|rendez-?vous|demande)\b/.test(t) || /\brappellera\s+pour\s+confirmer\b/.test(t))) return true;
    if (/\bc'?est\s+une\s+demande\s+de\s+rendez-?vous\b/i.test(t) || /\bdemande\s+de\s+rendez-?vous\s*,?\s*le\s+garage\s+vous\s+rappellera\b/i.test(t)) return true;
    if (/\b(le\s+garage\s+vous\s+)?rappellera\s+pour\s+confirmer\b/i.test(t) && (/\bnoté\b/.test(t) || /\bdemande\b/.test(t))) return true;
    if ((/\bj'?ai\s+bien\s+noté\b/.test(t) || /\bje\s+note\s+(votre\s+)?(demande\s+)?(pour\s+)?(le\s+)?(rdv|rendez-?vous)\b/i.test(t)) && /\b(rdv|rendez-?vous|jour|créneau)\b/.test(t)) return true;
    return false;
  }
  /** Retourne true si le message assistant indique que la demande de devis a été prise (toutes formulations). */
  function isAssistantConfirmingDevis(assistantText) {
    const t = String(assistantText || "").toLowerCase();
    if (!/\bdevis\b/.test(t)) return false;
    if (t.includes("je note ça pour le devis") || t.includes("je note ca pour le devis")) return true;
    if (t.includes("préparera le devis") || t.includes("preparera le devis")) return true;
    if (t.includes("recontactera") || (t.includes("rappellera") && t.includes("devis"))) return true;
    if ((t.includes("je note la demande") || t.includes("j'ai noté") || t.includes("j'ai note") || t.includes("note la demande") || t.includes("note votre demande")) && t.includes("devis")) return true;
    if ((t.includes("demande de devis") || t.includes("demande devis")) && (t.includes("noté") || t.includes("note") || t.includes("prise") || t.includes("pris"))) return true;
    if (t.includes("bien noté") && t.includes("devis")) return true;
    return false;
  }
  /** validation_devis = true dès que l'IA dit qu'elle va mettre en relation pour validation devis */
  function isAssistantSayingValidationDevisTransfer(assistantText) {
    const t = String(assistantText || "").toLowerCase();
    return /\bmettre\s+en\s+relation\s+(avec\s+)?(le\s+)?garage\s+pour\s+(la\s+)?validation\s+(de\s+)?(votre|ton)\s+devis\b/i.test(t)
      || /\b(je\s+)?(vais|va)\s+(vous|te)\s+mettre\s+en\s+relation.*validation.*devis\b/i.test(t)
      || /\b(vous|te)\s+mettre\s+en\s+relation.*(garage|validation).*devis\b/i.test(t);
  }
  function maybeSpeakCallbackAck() {
    if (callbackAckSpoken) return;
    if (!consentGiven) return;
    if (callbackRefusedByClient) {
      callbackAckSpoken = true;
      enqueuePremiumTts("Ok, je note : pas de rappel par le garage.", { interrupt: true, source: "callback_ack_refused", allowWithoutUser: false });
      return;
    }
    if (callbackAcceptedByClient) {
      callbackAckSpoken = true;
      enqueuePremiumTts("Ok, je note : le garage vous rappellera.", { interrupt: true, source: "callback_ack_accepted", allowWithoutUser: false });
    }
  }
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
        headers: autoguruApiHeaders(),
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
    }
  }
  let finalizeSent = false;
  async function finalizeCallToAutoGuru(reason = "stop") {
    try {
      if (finalizeSent) return;
      finalizeSent = true;
      const sidToFinalize = callSid;
      if (!sidToFinalize) return;
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return;
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return;
      const finalizeUrl = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/realtime-finalize");
      await ingestChain.catch(() => {});
      const RUN_ANALYSIS_DELAY_MS = Number(process.env.RUN_ANALYSIS_DELAY_MS ?? "3000");
      if (RUN_ANALYSIS_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, RUN_ANALYSIS_DELAY_MS));
      }
      const lastIntentAtFinalize = (() => {
        const raw = String(lastAssistantText || "");
        const questions = raw.match(/[^?.!\n\r]*\?/g) || [];
        const target = String(questions.length ? questions[questions.length - 1] : raw).toLowerCase();
        const asksRdv = (/\b(rendez-?vous|rdv|créneau)\b/.test(target) || /quel\s*jour|jour\s*vous\s*convient|matin|après-?midi/.test(target)) && target.includes("?");
        return asksRdv ? "rdv" : (getMostRecentAssistantIntent(25000));
      })();
      const assistantAskedForDayOrSlot = hasAskedDayOrSlot || ((lastIntentAtFinalize === "rdv") && /\b(quel\s*jour|matin|après-?midi|créneau|plutôt)\b/i.test(String(lastAssistantText || "")));
      const pureDevisFlow = devisAcceptedByClient && !assistantAskedForDayOrSlot;
      const rdvRequestedFromWs = !pureDevisFlow && ((rdvAcceptedByClient && !rdvRefusedByClient) || (assistantAskedForDayOrSlot && !rdvRefusedByClient));
      const callbackTypeFromWs = callbackRefusedByClient ? "none" : (rdvRequestedFromWs || modificationRdvByClient || annulationRdvByClient ? "rdv" : "info");
      console.log("🧾 Finalize:", sidToFinalize?.slice(-8) || "", reason, { devis_requested: devisAcceptedByClient, validation_devis: validationDevisByClient, rdv_requested: rdvRequestedFromWs, callback_type: callbackTypeFromWs, modification_rdv: modificationRdvByClient, annulation_rdv: annulationRdvByClient, transfer_to_garage_status: transferToGarageStatus });
      console.log("📌 [RDV] État badges au finalize:", { rdvAcceptedByClient, rdvRefusedByClient, callbackRefusedByClient, callbackAcceptedByClient, rdvRequestedFromWs, callbackTypeFromWs, assistantAskedForDayOrSlot });
      const lastLow = (lastAssistantText || "").toLowerCase().trim();
      const looksLikePostConsent = lastLow.includes("en quoi puis-je vous aider") || lastLow.includes("quel est votre besoin") || (lastLow.includes("dites-moi") && (lastLow.includes("souci") || lastLow.includes("puis-je vous aider"))) || /^bonjour\s+(monsieur|madame)\s+/i.test(String(lastAssistantText || "").trim());
      const effectiveConsentGranted = consentGiven || (consentRequired && !!lastAssistantText && looksLikePostConsent && userSpeakCount >= 1);
      if (consentRequired && !consentGiven && effectiveConsentGranted) {
        console.log("✅ Consentement inféré (IA a répondu après accueil + client a parlé au moins 1 fois):", lastAssistantText ? lastAssistantText.substring(0, 80) : "");
      }
      const hasMultiTurnExchange = assistantTurnCount >= 2;
      const noRequest = userSpeakCount < 1 && !assistantAskedForDayOrSlot && !hasMultiTurnExchange;
      const noRequestReason = "Le client n'a fait aucune demande";
      const rdvIncomplete = assistantAskedForDayOrSlot && !rdvAcceptedByClient; // Demande RDV, l'assistant a demandé jour/créneau, le client n'a pas donné de préférence
      const rdvIncompleteReason = "Le client a raccroché avant d'indiquer ses préférences de date pour le rendez-vous.";
      if (rdvIncomplete) console.log("📌 rdv_incomplete (WS envoie call_outcome + raison):", { userSpeakCount, rdvAcceptedByClient, lastAssistantText: (lastAssistantText || "").slice(0, 60) });
      if (noRequest) console.log("📌 no_request (client n'a pas parlé):", { userSpeakCount, assistantTurnCount });
      const finalizeResponse = await fetch(finalizeUrl, {
        method: "POST",
        headers: autoguruApiHeaders(),
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid: sidToFinalize,
          garageId: garageId || null,
          fromNumber: fromNumber || null,
          appointmentMode: appointmentMode || null,
          reason,
          consent_refused: reason === "consent_refused",
          callback_refused_rappele: callbackRefusedByClient,
          callback_accepted_rappele: callbackAcceptedByClient,
          devis_requested: devisAcceptedByClient,
          validation_devis: validationDevisByClient,
          rdv_refused: rdvRefusedByClient,
          rdv_accepted: rdvAcceptedByClient,
          rdv_requested: rdvRequestedFromWs,
          callback_type: callbackTypeFromWs,
          modification_rdv: modificationRdvByClient,
          annulation_rdv: annulationRdvByClient,
          ...(transferTriggered ? { transfer_to_garage: true } : {}),
          ...(transferToGarageStatus ? { transfer_to_garage_status: transferToGarageStatus } : {}),
          plate_confirmed_by_client: plateConfirmedByClient,
          ...(plateConfirmedByClient && clientInfo?.plate ? { plate: String(clientInfo.plate).trim() } : {}),
          consent_granted: effectiveConsentGranted,
          ...(noRequest ? { no_request: true, no_request_reason: noRequestReason } : {}),
          ...(rdvIncomplete ? { call_outcome: "rdv_incomplete", rdv_incomplete_reason: rdvIncompleteReason } : (rdvRequestedFromWs && rdvAcceptedByClient && assistantAskedForDayOrSlot ? { call_outcome: "completed" } : {})),
        }),
      }).catch((err) => {
        console.error("❌ Erreur lors de l'appel à realtime-finalize:", err);
        return null;
      });
      if (finalizeResponse) {
        if (!finalizeResponse.ok) {
          const errorText = await finalizeResponse.text().catch(() => "unknown error");
          let errObj = {};
          try { errObj = JSON.parse(errorText); } catch (_) {}
          console.error("❌ realtime-finalize a retourné une erreur:", finalizeResponse.status, errObj.error || errorText, errObj.message || "");
        } else {
          const result = await finalizeResponse.json().catch(() => null);
          if (LOG_VERBOSE) console.log("✅ Finalize réussi:", result); else console.log("✅ Finalize ok");
          const runAnalysisSecret = RUN_ANALYSIS_SECRET_ENV;
          const runAnalysisUrl = result?.runAnalysisUrl || (result?.callId && (String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "").replace(/\/api\/twilio\/realtime-finalize\/?$/i, "") + "/api/calls/" + result.callId + "/run-analysis"));
          console.log("🧾 Finalize run-analysis:", { callId: result?.callId, triggerAnalysis: !!result?.triggerAnalysis, hasUrl: !!runAnalysisUrl, hasSecret: !!runAnalysisSecret });
          if (result?.triggerAnalysis && runAnalysisUrl && runAnalysisSecret) {
            console.log("🔄 Run-analysis: envoi POST pour appel", result.callId, "(réponse dans 30–120 s)");
            fetch(runAnalysisUrl, {
              method: "POST",
              headers: autoguruApiHeaders(),
            }).then((r) => {
              if (r.ok) console.log("✅ Run-analysis terminé pour appel", result.callId);
              else console.warn("⚠️ Run-analysis non ok:", r.status, runAnalysisUrl.slice(0, 60) + "...");
            }).catch((err) => {
              console.warn("⚠️ Run-analysis (fire-and-forget) erreur:", err?.message || err);
            });
          } else if (result?.triggerAnalysis && result?.callId) {
            if (!runAnalysisSecret) console.warn("⚠️ RUN_ANALYSIS_SECRET non défini sur Render → run-analysis non appelé. L'appel restera en 'analyzing' jusqu'à traitement par le cron Vercel (run-pending-analyses).");
            if (!runAnalysisUrl) console.warn("⚠️ runAnalysisUrl manquant dans la réponse finalize → run-analysis non appelé.");
          }
        }
      } else {
        console.error("❌ Impossible d'appeler realtime-finalize (fetch a échoué)");
      }
    } catch {
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
        headers: autoguruApiHeaders(),
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
  async function requestPlateSmsIfNeeded(trigger = "assistant_plate_request", forceSend = false) {
    try {
      const ingestUrl = autoguruIngestUrl || AUTOGURU_INGEST_URL_ENV;
      if (!ingestUrl) return { sent: false, reason: "no_ingest_url" };
      const token = autoguruIngestToken;
      const secret = AUTOGURU_INGEST_SECRET_ENV;
      if (!token && !secret) return { sent: false, reason: "no_auth" };
      if (!callSid) return { sent: false, reason: "no_callsid" };
      const to = String(fromNumber || "").trim();
      if (!/^\+\d{8,15}$/.test(to)) return { sent: false, reason: "invalid_phone" };
      if (ws.__plateSmsRequested) return { sent: false, reason: "already_requested" };
      ws.__plateSmsRequested = true;
      const url = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/plate-sms/request");
      const shouldForce = forceSend || plateSmsSendOnFinalize;
      if (LOG_VERBOSE) console.log("📩 requestPlateSmsIfNeeded:", { trigger, forceSend, plateSmsSendOnFinalize, shouldForce });
      const resp = await fetch(url, {
        method: "POST",
        headers: autoguruApiHeaders(),
        body: JSON.stringify({
          ...(token ? { token } : { secret }),
          callSid,
          garageId: garageId || null,
          fromNumber: to,
          trigger,
          force: shouldForce, // Forcer si demandé explicitement ou si l'IA a proposé
        }),
      }).catch(() => null);
      if (resp && resp.ok) {
        const json = await resp.json().catch(() => ({}));
        if (json?.skipped === "client_has_plate" && json?.existingPlate) {
          if (forceSend || plateSmsSendOnFinalize) {
            console.log("📩 Client existe avec plaque mais l'IA a proposé d'envoyer un message, on force l'envoi du SMS.", { 
              trigger, 
              existingPlate: json.existingPlate,
              clientName: json.clientName,
              callSid,
              fromNumber: to,
              garageId: garageId || null
            });
            const forceUrl = String(ingestUrl).replace(/\/api\/twilio\/realtime-ingest\/?$/i, "/api/twilio/plate-sms/request");
            const forceResp = await fetch(forceUrl, {
              method: "POST",
              headers: autoguruApiHeaders(),
              body: JSON.stringify({
                ...(token ? { token } : { secret }),
                callSid,
                garageId: garageId || null,
                fromNumber: to,
                trigger: trigger + "_forced",
                force: true, // Forcer l'envoi même si le client a déjà une plaque
              }),
            }).catch(() => null);
            if (forceResp && forceResp.ok) {
              const forceJson = await forceResp.json().catch(() => ({}));
              const smsSid = forceJson?.smsSid ?? null;
              const isSent = Boolean(smsSid || forceJson?.status === "sent");
              if (isSent) {
                console.log("📩 SMS plaque envoyé (forcé malgré plaque existante).", { trigger, smsSid });
                return { sent: true, smsSid, forced: true };
              }
            }
          }
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
        if (LOG_VERBOSE) console.log("📩 Demande SMS plaque envoyée à l'API:", { 
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
        headers: autoguruApiHeaders(),
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
  let plateSmsWaitingForReply = false;
  let plateSmsPollTimer = null;
  let plateSmsSendOnFinalize = false;
  let plateSmsAlreadyMentioned = false; // Track si l'IA a déjà mentionné l'envoi d'un SMS pour la plaque
  let plateConfirmedByClient = false;  // Si true: client a confirmé la plaque énoncée par l'IA pour le RDV → pas de SMS, valider en dossier
  function isAffirmativeFr(text) {
    const t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    return /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila)(\s+oui|\s+merci)?\.?$/i.test(t.replace(/\s+/g, " ")) || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|voilà|voila)\b/.test(t);
  }
  function isNegativeFr(text) {
    const t = String(text || "").toLowerCase().trim();
    if (!t) return false;
    return /\b(non|nope|pas du tout|nann|laisse tomber)\b/.test(t) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(t.replace(/\s+/g, " "));
  }
  function isRealGoodbye(text) {
    const fullText = String(text || "").trim().toLowerCase();
    if (!fullText) return false;
    const lastPart = fullText.slice(-100); // Derniers 100 caractères = vraie conclusion
    const goodbyePatternsEnd = [
      "au revoir", "aurevoir",
      "merci et au revoir", "merci et bonne journée", "merci et bonne journee",
      "à très bientôt", "a tres bientot", "à plus tard", "a plus tard",
      "je vous souhaite une bonne journée", "je vous souhaite une bonne journee",
      "excellente journée", "excellente journee", "passez une bonne journée", "passez une bonne journee",
      "au revoir et bonne journée", "aurevoir et bonne journee", "au revoir, bonne journée", "aurevoir, bonne journee"
    ];
    const standaloneGoodbyePatterns = [
      "bonne journée", "bonne journee", "bonne journée à vous", "bonne journee a vous", "bonne journée à vous !", "bonne journee a vous !"
    ];
    const hasQuestion = fullText.includes("?") || fullText.includes("comment") || fullText.includes("quel") || fullText.includes("pourquoi") || fullText.includes("quand") || fullText.includes("où");
    const isIncomplete = fullText.trim().endsWith(",") || fullText.trim().endsWith(":") || fullText.trim().endsWith("...");
    const hasStrictGoodbye = goodbyePatternsEnd.some(pattern => lastPart.includes(pattern));
    const isStandaloneGoodbye = standaloneGoodbyePatterns.some(pattern => {
      const patternIndex = fullText.indexOf(pattern);
      if (patternIndex === -1) return false;
      const textAfterPattern = fullText.substring(patternIndex + pattern.length);
      const isAtEnd = textAfterPattern.length < 50;
      const isNormalConclusion = fullText.includes("transmettre") || fullText.includes("rappelleront") || fullText.includes("confirmer") || fullText.includes("demande");
      return isAtEnd && !isNormalConclusion;
    });
    return (hasStrictGoodbye || isStandaloneGoodbye) && !hasQuestion && !isIncomplete;
  }
  const NOISE_FILTER_STRICT = (process.env.NOISE_FILTER_STRICT ?? "1").toLowerCase() === "1" || (process.env.NOISE_FILTER_STRICT ?? "1") === "true";
  /** Détection solide du bruit ambiant / non-parole : ne pas prendre comme réponse client. */
  function isJunkTranscript(text) {
    const t = String(text || "").trim();
    const lower = t.toLowerCase();
    if (!t) return true;
    if (lower.includes("amara.org") || lower.includes("sous-titres") || lower.includes("sous titres")) return true;
    if (lower.includes("réalisés par la communauté") || lower.includes("vidéo") || lower.includes("video") || lower.includes("youtube") || lower.includes("channel")) return true;
    if (lower.includes("ontario") || lower.includes("partenariat") || lower.includes("merci d'avoir regardé") || lower.includes("subscribe") || lower.includes("like") || lower.includes("comment")) return true;
    if (lower.includes("au bois") || lower.includes("dans la forêt") || lower.includes("dans le bois") || lower.includes("je suis dans") || lower.includes("nous sommes dans") || lower.includes("on est dans")) return true;
    if (lower.includes("audio-description") || lower.includes("audio description")) return true;
    if (lower.includes("sous-titrage") && (lower.includes("radio-canada") || lower.includes("radio canada") || lower.includes("société") || lower.includes("src"))) return true;
    if (lower.includes("sous-titrage société") || /sous[- ]?titrage\s*(société\s+)?radio[- ]?canada/i.test(t)) return true;
    if (/^[\s.\u2026\u00A0\-–—,;:!?]*$/.test(t) || /^(\s*[.\u2026]\s*)+$/.test(t)) return true;
    const stripped = lower.replace(/[\s\p{P}\p{S}]/gu, "");
    if (stripped.length < 3) return true;
    const shortValid = ["oui", "ouais", "ouai", "oua", "ok", "non", "nan", "nope", "dac", "daccord", "voila", "voilà"];
    if (shortValid.includes(stripped)) return false;
    if (NOISE_FILTER_STRICT && stripped.length < 5) return true;
    const isolatedNoise = /^(ah|eh|oh|mm|hmm|euh|hum|huh|uh|mh|hm|hein|quoi|bah|ben|a|e|i|o|u|euh euh|ah ah|oh oh|mhm|mmm)$/i.test(lower);
    if (isolatedNoise) return true;
    if (/^(\S{1,3}\s+){2,}\1\s*$/i.test(lower) || /^(euh\s+)+euh\s*$/i.test(lower)) return true;
    const words = t.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return true;
    const oneWordOk = ["oui", "ouais", "ouai", "non", "ok", "aller", "merci", "salut", "allo", "bonjour", "bonsoir", "d'accord", "dac", "voilà", "voila", "nan", "nope"];
    if (words.length === 1) {
      if (words[0].length < 3) return true;
      if (NOISE_FILTER_STRICT && words[0].length < 4 && !oneWordOk.includes(words[0].toLowerCase())) return true;
    }
    if (words.length <= 2 && t.length < 12) {
      const commonFrench = ["oui", "ouais", "ouai", "non", "oui oui", "non non", "oui merci", "non merci", "d'accord", "ok ok", "bonjour oui", "oui s'il vous plaît", "euh oui", "ben oui", "ah oui", "ouais oui", "c'est bon", "c'est ça"];
      const normalized = lower.replace(/\s+/g, " ").trim();
      if (!commonFrench.some(phrase => normalized === phrase || normalized.startsWith(phrase + " ") || normalized.endsWith(" " + phrase))) {
        if (words.some(w => w.length < 2)) return true;
        if (NOISE_FILTER_STRICT && t.length < 8) return true;
      }
    }
    const letterRatio = (lower.match(/[a-zàâäéèêëïîôùûüç]/g) || []).length / Math.max(1, stripped.length);
    if (letterRatio < 0.5 && stripped.length > 4) return true;
    if (/^(.)\1{4,}$/.test(stripped)) return true;
    const contextWords = ["parc", "plage", "mer", "montagne", "campagne", "ville", "rue", "avenue", "boulevard"];
    const garageRelated = ["voiture", "véhicule", "garage", "problème", "panne", "rendez-vous", "rdv", "diagnostic", "frein", "batterie", "moteur"];
    if (contextWords.some(w => lower.includes(w)) && !garageRelated.some(w => lower.includes(w))) return true;
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
        headers: autoguruApiHeaders(),
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
      plateSmsWaitingForReply = false;
      if (plateSmsPollTimer) {
        clearInterval(plateSmsPollTimer);
        plateSmsPollTimer = null;
      }
      try {
        if (!clientInfo) clientInfo = {};
        clientInfo.plate = plate;
      } catch {}
      enqueueIngest("assistant", `Plaque reçue par SMS: ${plate}.`);
      const confirmText = `Parfait, j'ai bien reçu votre plaque ${plate}. Merci. Je continue maintenant.`;
      enqueueElevenLabsTts(confirmText, { interrupt: true });
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
    }
  }
  const STT_MODEL = process.env.STT_MODEL ?? "whisper-1";
  const STT_LANGUAGE = process.env.STT_LANGUAGE ?? "fr";
  const STT_PROMPT = process.env.STT_PROMPT ?? "Garage auto, pièces: vidange, freins, plaquettes, disques, embrayage, courroie de distribution, pneus, climatisation, diagnostic. Plaques françaises: AB-123-CD. Le client parle français. Transcription précise des phrases complètes du client.";
  const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o";
  const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? "0.75"); // 0.75 = plus naturel, moins rigide
  const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? "160");
  const STT_SPEECH_THRESHOLD = Number(process.env.STT_SPEECH_THRESHOLD ?? "1500");
  const STT_SPEECH_FRAMES = Number(process.env.STT_SPEECH_FRAMES ?? "6"); // ~120ms
  const STT_SILENCE_THRESHOLD = Number(process.env.STT_SILENCE_THRESHOLD ?? "650");
  const STT_SILENCE_FRAMES = Number(process.env.STT_SILENCE_FRAMES ?? "30"); // ~600ms: laisser le client finir sa phrase
  const STT_MIN_AUDIO_MS = Number(process.env.STT_MIN_AUDIO_MS ?? "550");
  const HISTORY_MAX_TURNS = Number(process.env.HISTORY_MAX_TURNS ?? "8");
  const BACKCHANNEL_ENABLED = (process.env.BACKCHANNEL_ENABLED ?? "true").toLowerCase() === "true";
  const BACKCHANNEL_TEXT = process.env.BACKCHANNEL_TEXT ?? "D'accord, je note…";
  const BACKCHANNEL_DELAY_MS = Number(process.env.BACKCHANNEL_DELAY_MS ?? "1500");
  const BACKCHANNEL_MIN_INTERVAL_MS = Number(process.env.BACKCHANNEL_MIN_INTERVAL_MS ?? "20000");
  const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? "15000");
  let backchannelTimer = null;
  let lastBackchannelAt = 0;
  let llmInFlight = false;
  const RESPONSE_CREATE_DEBOUNCE_MS = Number(process.env.RESPONSE_CREATE_DEBOUNCE_MS ?? "700");
  const WATCHDOG_AFTER_COMMIT_MS = Number(process.env.WATCHDOG_AFTER_COMMIT_MS ?? "120"); // plus court = reprise plus rapide après que le client parle (évite de répéter 2x)
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
        STT_SILENCE_FRAMES,
        STT_MIN_AUDIO_MS,
      });
    } catch {
    }
  }
  function nowMs() {
    return Date.now();
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function resample8kTo16k(pcm8k) {
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
    const timeoutMs = isGpt5 ? Math.max(45_000, LLM_TIMEOUT_MS) : LLM_TIMEOUT_MS;
    if (isGpt5) {
      console.log("⏱️ LLM timeout (gpt-5):", { timeoutMs });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (isGpt5) {
        const systemMsg = (messages || []).find((m) => m?.role === "system")?.content ?? "";
        const prompt = buildPromptFromMessages(messages);
        const body = {
          model,
          input: String(prompt),
          instructions: String(systemMsg || ""),
          max_output_tokens: LLM_MAX_TOKENS,
        };
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
      const cleaned = transcript.replace(/[\s'’"“”]/g, "").trim();
      if (cleaned.length < 3 || /^[\p{P}\p{S}]+$/u.test(cleaned)) {
        console.log("🧹 STT ignoré (trop court/bruit):", { transcript });
        return;
      }
      console.log("🎤 STT:", transcript);
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
    const rawText = String(text || "").substring(0, 200);
    if (LOG_VERBOSE) console.log(`🔊 Minimax TTS entry: "${rawText.substring(0, 80)}${rawText.length > 80 ? "…" : ""}"`);
    const useMalePreview = assistantVoice === "male" || assistantVoice === "minimax_male";
    const selectedVoiceIdPreview = useMalePreview
      ? (MINIMAX_VOICE_ID_MALE || MINIMAX_VOICE_ID_DEFAULT)
      : (MINIMAX_VOICE_ID_FEMALE || MINIMAX_VOICE_ID_DEFAULT);
    if (LOG_VERBOSE) console.log("🔊 [Minimax] guards:", { enabled: PREMIUM_TTS_ENABLED, provider: PREMIUM_TTS_PROVIDER, hasMinimaxKey: !!MINIMAX_API_KEY, hasVoice: !!(selectedVoiceIdPreview && selectedVoiceIdPreview.trim()) });
    const lastTextPreview = premiumTtsLastText ? premiumTtsLastText.substring(0, 50) : "null";
    if (LOG_TTS) {
      console.log(`[TTS-MINIMAX] ENTRÉE [interrupt=${interrupt}] [inFlight=${premiumTtsInFlight}] [lastText=${lastTextPreview}]`);
      console.log(`[TTS-MINIMAX] TEXTE:`, rawText);
      if (LOG_VERBOSE) console.log(`🚨 speakWithMinimaxNow ENTRÉE:`, rawText?.substring(0, 80));
    }
    if (!PREMIUM_TTS_ENABLED) {
      if (LOG_TTS) {
        console.log(`[TTS-MINIMAX] SORTIE: PREMIUM_TTS_ENABLED=false`);
        if (LOG_VERBOSE) console.log(`🚨 speakWithMinimaxNow SORTIE: PREMIUM_TTS_ENABLED=false`);
      }
      return;
    }
    const useMinimaxForThisVoice = PREMIUM_TTS_PROVIDER === "minimax" || assistantVoice === "minimax_male";
    if (!useMinimaxForThisVoice) {
      if (LOG_TTS) {
        console.log(`[TTS-MINIMAX] SORTIE: provider=${PREMIUM_TTS_PROVIDER}, voice=${assistantVoice} (Minimax utilisé si voix=minimax_male)`);
        if (LOG_VERBOSE) console.log(`🚨 speakWithMinimaxNow SORTIE: PREMIUM_TTS_PROVIDER=${PREMIUM_TTS_PROVIDER} !== minimax et assistantVoice !== minimax_male`);
      }
      return;
    }
    if (nowMs() < premiumTtsBypassUntilMs) {
      const remainingMin = Math.ceil((premiumTtsBypassUntilMs - nowMs()) / 60000);
      console.warn(`🔊 Minimax SORTIE: bypass actif (reste ~${remainingMin} min). Pas de TTS jusqu'à la fin du bypass.`);
      return;
    }
    const useMaleVoice = assistantVoice === "male" || assistantVoice === "minimax_male";
    const selectedVoiceId = useMaleVoice
      ? (MINIMAX_VOICE_ID_MALE || MINIMAX_VOICE_ID_DEFAULT)
      : (MINIMAX_VOICE_ID_FEMALE || MINIMAX_VOICE_ID_DEFAULT);
    if (!MINIMAX_API_KEY || !selectedVoiceId || !String(selectedVoiceId).trim()) {
      console.error("❌ PREMIUM_TTS activé mais MINIMAX_API_KEY ou MINIMAX_VOICE_ID manquants. Définir MINIMAX_VOICE_ID (ex: French_Female_News Anchor) et MINIMAX_VOICE_ID_MALE sur Render.");
      premiumTtsLastError = "Configuration Minimax incomplète (clé ou voix manquante)";
      premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000; // 5 min de bypass
      return;
    }
    if (LOG_VERBOSE) console.log("🔊 Minimax: bypass OK, voix OK → connexion WebSocket...");
    const rawTextBeforeNormalization = (text || "").trim();
    const clean = normalizeFrenchTtsText(rawTextBeforeNormalization);
    if (!clean) return;
    const textToSend = sanitizeTextForMinimax(clean);
    if (!textToSend) return;
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
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.clear"
        }));
      } catch (err) {
        console.warn("⚠️ Erreur lors de la désactivation de l'input audio:", err);
      }
    }
    let minimaxWs = null;
    try {
      let wsUrl = "wss://api.minimax.io/ws/v1/t2a_v2";
      const useBalanceForThisCall = MINIMAX_USE_BALANCE || !MINIMAX_GROUP_ID;
      if (!useBalanceForThisCall && MINIMAX_GROUP_ID) {
        wsUrl += `?GroupId=${encodeURIComponent(MINIMAX_GROUP_ID)}`;
      } else if (LOG_VERBOSE) {
        console.log("🔊 Minimax: facturation sur le solde (pas de GroupId).");
      }
      const apiKey = MINIMAX_API_KEY.startsWith("Bearer ") ? MINIMAX_API_KEY.substring(7) : MINIMAX_API_KEY;
      if (LOG_VERBOSE) console.log("🔊 Minimax: connecting WS...");
      if (LOG_MINIMAX_EVENTS) {
        console.log("🔌 Connexion Minimax WebSocket...", { url: wsUrl.replace(/GroupId=[^&]+/, "GroupId=***") });
      }
      minimaxWs = new WebSocket(wsUrl, {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      });
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
      if (LOG_VERBOSE) console.log("🔊 Minimax: waiting WS open (10s)...");
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
      if (LOG_VERBOSE) console.log("🔊 Minimax: WS open, waiting connected_success (5s)...");
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
      if (LOG_VERBOSE) console.log("🔊 Minimax: connected_success ok");
      if (LOG_MINIMAX_EVENTS) console.log("✅ Minimax WebSocket connecté:", connectedMsg);
      const taskStartMsg = {
        event: "task_start",
        model: MINIMAX_MODEL || "speech-2.6-hd", // Utiliser un modèle supporté pour WebSocket
        voice_setting: {
          voice_id: selectedVoiceId,
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
      if (LOG_VERBOSE) console.log("🔊 Minimax: waiting task_started (5s)...");
      const taskStartedMsg = await waitForMessage("task_started");
      if (LOG_VERBOSE) console.log("🔊 Minimax: task_started ok, sending text...");
      if (LOG_MINIMAX_EVENTS) console.log("✅ Tâche Minimax démarrée:", taskStartedMsg);
      const continueMsg = {
        event: "task_continue",
        text: textToSend,
      };
      if (LOG_MINIMAX_EVENTS || LOG_TTS) {
        console.log("📤 Texte envoyé à Minimax TTS:", textToSend.substring(0, 200) + (textToSend.length > 200 ? "…" : ""));
        console.log("📤 Longueur:", textToSend.length, "caractères");
      }
      minimaxWs.send(JSON.stringify(continueMsg));
      if (LOG_VERBOSE) console.log("🔊 Minimax: text sent, waiting audio (while loop, 30s timeout/msg)...");
      let audioData = Buffer.alloc(0);
      let chunkCounter = 0;
      let isFinal = false;
      let lastMessageTime = nowMs();
      let firstMsgInLoop = true;
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
        if (firstMsgInLoop) {
          if (LOG_VERBOSE) console.log(`🔊 Minimax: first msg in loop event=${msg.event || "data"} is_final=${!!msg.is_final} hasAudio=${!!(msg.data && msg.data.audio)}`);
          firstMsgInLoop = false;
        }
        if (LOG_MINIMAX_EVENTS) {
          console.log("📨 Minimax réponse:", msg.event || "data", {
            hasData: !!(msg.data),
            hasAudio: !!(msg.data && msg.data.audio),
            isFinal: msg.is_final,
            audioLength: msg.data?.audio ? msg.data.audio.length : 0,
          });
        }
        if (msg.data && msg.data.audio) {
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
        }
        if (msg.is_final || msg.event === "task_finished") {
          isFinal = true;
          if (LOG_VERBOSE) console.log(`✅ Minimax TTS terminé: ${chunkCounter} chunks, ${audioData.length} bytes`); else console.log(`TTS ok (${chunkCounter} chunks)`);
          if (audioData.length > 0) {
            try {
          if (LOG_MINIMAX_EVENTS) console.log(`🎵 Décodage PCM: ${audioData.length} bytes`);
              const pcmRaw = new Int16Array(
                audioData.buffer,
                audioData.byteOffset,
                audioData.length / 2,
              );
              const expectedSampleRate = (pcmRaw.length > 20000) ? 32000 : 8000;
              if (LOG_MINIMAX_EVENTS) {
                console.log(`🎵 PCM reçu: ${pcmRaw.length} samples (détecté: ${expectedSampleRate}Hz)`);
              }
              let mulaw;
              if (expectedSampleRate === 32000) {
                mulaw = convertPcm32kToMulaw(pcmRaw);
                if (LOG_MINIMAX_EVENTS) {
                  console.log(`🎵 Downsampled: ${pcmRaw.length} samples @ 32kHz → ${mulaw.length} samples @ 8kHz`);
                }
              } else {
                mulaw = convertPcm8kToMulaw(pcmRaw);
                console.log(`🎵 Converti: ${pcmRaw.length} samples @ 8kHz → ${mulaw.length} samples μ-law`);
              }
              const chunkSize = 160;
              for (let i = 0; i < mulaw.length; i += chunkSize) {
                const chunk = mulaw.slice(i, i + chunkSize);
                const mulawBuf = Buffer.from(chunk);
                enqueueOutboundMulaw(mulawBuf);
                const currentBacklogFrames = Math.floor(outboundQueuedBytes / 160);
                if (currentBacklogFrames < 100 && i % (chunkSize * 10) === 0) {
                  await sleep(5);
                }
              }
              if (LOG_VERBOSE) console.log(`🎙️ Minimax TTS audio envoyé: ${Math.ceil(mulaw.length / chunkSize)} chunks`);
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
      minimaxWs.send(JSON.stringify({ event: "task_finish" }));
      minimaxWs.close();
      if (premiumTtsBypassUntilMs > 0) {
        console.log("✅ Minimax fonctionne → réinitialisation du fallback");
        premiumTtsBypassUntilMs = 0;
        premiumTtsLastError = null;
      }
      premiumTtsInFlight = false;
      const checkAndReenableInput = () => {
        if (!(outboundQueuedBytes === 0 && outboundQueue.length === 0)) {
          setTimeout(checkAndReenableInput, 100);
        }
      };
      setTimeout(checkAndReenableInput, 200);
    } catch (err) {
      premiumTtsInFlight = false;
      const errorMsg = err?.message || String(err);
      console.log(`❌ Minimax TTS error: ${errorMsg}`);
      if (minimaxWs) {
        try {
          minimaxWs.close();
        } catch {}
      }
      if (err.name === "AbortError") {
        console.log("🛑 Minimax TTS annulé (interrupt)");
        return;
      }
      console.error("❌ Erreur Minimax TTS WebSocket:", errorMsg);
      premiumTtsLastError = errorMsg;
      if (errorMsg.includes("insufficient credit") || errorMsg.includes("2053")) {
        console.error("💳 Minimax TTS: crédit insuffisant (2053). Vous utilisez la facturation solde (pas de GroupId). Rechargez le solde sur https://platform.minimax.io/user-center/payment/balance puis réessayez.");
      }
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
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.clear"
        }));
      } catch (err) {
        console.warn("⚠️ Erreur lors de la désactivation de l'input audio:", err);
      }
    }
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
        premiumTtsBypassUntilMs = nowMs() + 5 * 60 * 1000;
        console.warn("↩️ FALLBACK ACTIVÉ: ElevenLabs en erreur → utilisation audio OpenAI pendant 5 min.");
        console.warn("   Pour désactiver le fallback, redémarre le serveur ou attends 5 min.");
        console.warn("   Vérifie ELEVENLABS_API_KEY, crédits ElevenLabs, et voice ID.");
        return;
      }
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
          while (pcmBuf.length >= 160) {
            const frame = pcmBuf.subarray(0, 160);
            pcmBuf = pcmBuf.subarray(160);
            enqueueOutboundMulaw(frame);
            while (outboundQueuedBytes > maxBacklogBytes) {
              await sleep(20);
            }
          }
        } else {
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
      console.log("🎙️ ElevenLabs TTS terminé.", { chars: clean.length });
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
      const checkAndReenableInput = () => {
        if (!(outboundQueuedBytes === 0 && outboundQueue.length === 0)) {
          setTimeout(checkAndReenableInput, 100);
        }
      };
      setTimeout(checkAndReenableInput, 200);
    }
  }
  const CONSENT_REFUSAL_MESSAGE = "Votre refus a été pris en compte. Bonne journée.";
  /** Garantit qu'une réponse d'explication de l'assistant se termine par une question (guidage client). */
  function ensureAssistantReplyEndsWithQuestion(text) {
    const s = String(text || "").trim();
    if (!s) return s;
    if (s.slice(-1) === "?") return s;
    const lower = s.toLowerCase();
    if (lower.includes("au revoir") || lower.includes("bonne journée") || lower.includes("à bientôt")) return s;
    if (s.length < 40) return s;
    const hasCausePhrase = /\b(peut|pourrait)\s+(indiquer|venir|être|provenir)\b/i.test(s) ||
      lower.includes("alternateur") || lower.includes("système de charge") || lower.includes("système d'charge") ||
      (lower.includes("batterie") && (lower.includes("problème") || lower.includes("souci") || lower.includes("peut") || lower.includes("voyant")));
    const lastPart = s.slice(-100);
    const lastPartLower = lastPart.toLowerCase();
    const endsWithCauseWord = /(alternateur|charge|batterie|système)\s*\.?\s*$/.test(lastPartLower) ||
      (lastPartLower.includes("peut indiquer") || lastPartLower.includes("peut venir") || lastPartLower.includes("pourrait venir"));
    const looksLikeExplanation = hasCausePhrase || (endsWithCauseWord && (lower.includes("voyant") || lower.includes("problème") || lower.includes("souci")));
    if (!looksLikeExplanation) return s;
    return s + " Depuis quand avez-vous remarqué ce problème ?";
  }
  function looksLikeAssistantResponseToRefusal(text) {
    const t = String(text || "").toLowerCase();
    if (/\brappel(er|é)?\b/.test(t) || t.includes("être rappelé") || t.includes("pas de rappel")) return false;
    if (t.includes("pas enregistré") || t.includes("ne sera pas enregistré")) return true;
    if (t.includes("enregistrement") && (t.includes("désactivé") || t.includes("pas enregistré"))) return true;
    if (t.includes("pas de souci") && t.includes("enregistrement")) return true;
    const lastLower = String(lastAssistantText || "").toLowerCase();
    const lastWasCallbackQuestion = /\b(rappeler|rappel)\b/.test(lastLower) && (lastLower.includes("souhaitez") || lastLower.includes("voulez") || lastLower.includes("?"));
    if (lastWasCallbackQuestion) return false;
    if (t.length < 400 && t.includes("pas de souci") && (t.includes("au revoir") || t.includes("bonne journée") || t.includes("nous sommes là") || t.includes("besoin d'aide"))) return true;
    return false;
  }
  function playConsentRefusalAndHangup() {
    ws.__consentRefused = true;
    premiumTtsQueue = [];
    try { premiumTtsAbort?.abort?.(); } catch (_) {}
    outboundQueue = []; outboundQueuedBytes = 0;
    enqueuePremiumTts(CONSENT_REFUSAL_MESSAGE, {
      interrupt: true,
      source: "consent_refusal",
      allowWithoutUser: true,
      onComplete: () => {
        const waitForOutboundDrain = () => {
          if (outboundQueuedBytes === 0 && outboundQueue.length === 0) {
            const hangupDelayMs = 1500;
            console.log("🛑 Consent refusé: phrase terminée, raccrochage dans " + (hangupDelayMs / 1000) + " s.");
            setTimeout(() => {
              finalizeCallToAutoGuru("consent_refused");
              triggerHangup("consent_refused");
            }, hangupDelayMs);
            return;
          }
          setTimeout(waitForOutboundDrain, 200);
        };
        waitForOutboundDrain();
      },
    });
  }
  /** Corrige tarif/horaires inventés par l'IA pour RDV. Retourne le texte corrigé ou l'original. */
  function applyPricingHoursGuard(text) {
    const t = String(text || "").trim();
    if (!t) return text;
    const noRecentGarageTool = !(lastGarageToolOutputAt > 0 && (nowMs() - lastGarageToolOutputAt) < 15000);
    const talksAboutPriceAndHours = /\b(tarif|prix|euros?)\b/i.test(t) && /\b(horaires?|ouvert|heures?)\b/i.test(t);
    const talksAboutRdv = /\b(rendez-?vous|rdv)\b/i.test(t) || /\bquel jour vous conviendrait le mieux\b/i.test(t);
    if (!noRecentGarageTool || !talksAboutPriceAndHours || !talksAboutRdv || !pricingSummary) return text;
    const ctx = `${lastUserTextPendingIngest || ""} ${t}`.toLowerCase();
    const prestation = (/disque/.test(ctx) && /frein/.test(ctx)) ? "disques"
      : ((/plaquette/.test(ctx) || (/\bfrein/.test(ctx) && !/disque/.test(ctx))) ? "plaquettes"
        : (/diagnostic/.test(ctx) ? "diagnostic" : (/vidange/.test(ctx) ? "vidange" : (/r[eé]vision/.test(ctx) ? "révision" : ""))));
    if (!prestation) return text;
    const lines = String(pricingSummary).split("\n").map((l) => l.trim()).filter(Boolean);
    let matched = null;
    if (/disque/.test(prestation)) matched = lines.find((l) => /^[^:]*disque/i.test(l) && /^[^:]*frein/i.test(l));
    if (!matched && /plaquette|frein/.test(prestation)) matched = lines.find((l) => /^[^:]*plaquette/i.test(l) && /^[^:]*frein/i.test(l) && !/^[^:]*disque/i.test(l));
    if (!matched && /diagnostic/.test(prestation)) matched = lines.find((l) => /^[^:]*diagnostic/i.test(l));
    if (!matched && /vidange/.test(prestation)) matched = lines.find((l) => /^[^:]*vidange/i.test(l));
    if (!matched && /r[eé]vision/.test(prestation)) matched = lines.find((l) => /^[^:]*r[eé]vision/i.test(l));
    if (!matched) return text;
    const cleanedMatched = matched.replace(/\s*\(\s*\d+\s*h(?:\s*\d+)?\s*min\s*\)\s*$/i, "").replace(/\s*\(\s*\d+\s*min\s*\)\s*$/i, "").trim();
    const pricePart = cleanedMatched.includes(":") ? cleanedMatched.split(":").slice(1).join(":").trim() : cleanedMatched;
    const prestationLabel = ({ plaquettes: "le changement des plaquettes de frein", disques: "le changement des disques de frein", "révision": "la révision" })[prestation] || prestation;
    const corrected = `D'accord, nous allons faire une demande de rendez-vous. Le tarif pour ${prestationLabel} est de ${pricePart}. Les horaires sont ${garageHoursText || "les horaires du garage"}. Quel jour vous conviendrait le mieux ?`;
    console.warn("🛡️ Correction serveur (tarif/horaires inventés):", { prestation, pricePart: pricePart.substring(0, 60) });
    return corrected;
  }
  function enqueuePremiumTts(text, { interrupt = true, source = "unknown", responseId = null, allowWithoutUser = false, onComplete = null } = {}) {
    if (ws.__consentRefused && source !== "consent_refusal") {
      if (LOG_TTS) console.log("[TTS] Ignoré (consentement refusé, seul le message de refus est joué).");
      return;
    }
    const rawTextStr = String(text || "");
    const rawText = String(text || "").substring(0, 200);
    if (LOG_TTS) {
      console.log(`[TTS-ENQUEUE] ENTRÉE [source: ${source}] [interrupt=${interrupt}] [queueLen=${premiumTtsQueue.length}] [inFlight=${premiumTtsInFlight}]`);
      console.log(`[TTS-ENQUEUE] TEXTE:`, rawText);
      if (LOG_VERBOSE) {
        console.log(`🚨 enqueuePremiumTts [source: ${source}]:`, rawText?.substring(0, 80));
        console.log(`🚨 enqueuePremiumTts (interrupt=${interrupt}, queueLen=${premiumTtsQueue.length})`);
      }
    }
    if (!PREMIUM_TTS_ENABLED) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] SORTIE: PREMIUM_TTS_ENABLED=false`);
        if (LOG_VERBOSE) console.log(`🚨 enqueuePremiumTts SORTIE: PREMIUM_TTS_ENABLED=false`);
      }
      return;
    }
    const normalized = normalizeFrenchTtsText((text || "").trim());
    if (!normalized) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] SORTIE: texte vide après normalisation`);
        if (LOG_VERBOSE) console.log(`🚨 enqueuePremiumTts SORTIE: texte vide`);
      }
      return;
    }
    let clean = clipTtsText(normalized, MAX_TTS_CHARS);
    if (clean.length < normalized.length) {
      if (LOG_TTS) console.log(`[TTS-ENQUEUE] TEXTE TRONQUÉ: ${normalized.length} -> ${clean.length} chars`);
    }
    clean = clean
      .replace(/\s*Je vais (d'abord )?vérifier[^.]*\.\s*Un instant(?:,\s*s'il vous plaît)?[,.]?\s*$/gi, "")
      .replace(/\s*Je vais (d'abord )?vérifier[^.]*\.\s*Un instant[,.]?\s*je m'en occupe[.,]?\s*$/gi, "")
      .replace(/\s*[,.]?\s*Un instant[,.]?\s*je m'en occupe[.,]?\s*$/gi, "")
      .replace(/\s*[,.]?\s*Un instant[,.]?\s*$/gi, "")
      .replace(/\s*[,.]?\s*Je m'en occupe[.,]?\s*$/gi, "")
      .replace(/,\s*$/, "")
      .trim();
    if (clean.endsWith("..")) clean = clean.replace(/\.+$/, ".");
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
    const assistantReplySources = ["conversation.item.done", "response.output_text.done", "response.done", "response.output_item.done", "legacy_elevenlabs"];
    let textToSpeak = assistantReplySources.includes(source) ? ensureAssistantReplyEndsWithQuestion(clean) : clean;
    if (assistantReplySources.includes(source)) {
      const noRecentGarageTool = !(lastGarageToolOutputAt > 0 && (nowMs() - lastGarageToolOutputAt) < 15000), talksAboutPriceAndHours = /\b(tarif|prix|euros?)\b/i.test(textToSpeak) && /\b(horaires?|ouvert|heures?)\b/i.test(textToSpeak), talksAboutRdv = /\b(rendez-?vous|rdv)\b/i.test(textToSpeak) || /\bquel jour vous conviendrait le mieux\b/i.test(textToSpeak);
      if (noRecentGarageTool && talksAboutPriceAndHours && talksAboutRdv) {
        const ctx = `${lastUserTextPendingIngest || ""} ${textToSpeak}`.toLowerCase();
        const prestation = (/disque/.test(ctx) && /frein/.test(ctx)) ? "disques"
          : ((/plaquette/.test(ctx) || (/\bfrein/.test(ctx) && !/disque/.test(ctx))) ? "plaquettes"
            : (/diagnostic/.test(ctx) ? "diagnostic" : (/vidange/.test(ctx) ? "vidange" : (/r[eé]vision/.test(ctx) ? "révision" : ""))));
        if (prestation && pricingSummary) {
          const lines = String(pricingSummary).split("\n").map((l) => l.trim()).filter(Boolean);
          let matched = null;
          if (/disque/.test(prestation)) matched = lines.find((l) => /^[^:]*disque/i.test(l) && /^[^:]*frein/i.test(l));
          if (!matched && /plaquette|frein/.test(prestation)) matched = lines.find((l) => /^[^:]*plaquette/i.test(l) && /^[^:]*frein/i.test(l) && !/^[^:]*disque/i.test(l));
          if (!matched && /diagnostic/.test(prestation)) matched = lines.find((l) => /^[^:]*diagnostic/i.test(l));
          if (!matched && /vidange/.test(prestation)) matched = lines.find((l) => /^[^:]*vidange/i.test(l));
          if (!matched && /r[eé]vision/.test(prestation)) matched = lines.find((l) => /^[^:]*r[eé]vision/i.test(l));
          if (matched) {
            const cleanedMatched = matched.replace(/\s*\(\s*\d+\s*h(?:\s*\d+)?\s*min\s*\)\s*$/i, "").replace(/\s*\(\s*\d+\s*min\s*\)\s*$/i, "").trim();
            const pricePart = cleanedMatched.includes(":") ? cleanedMatched.split(":").slice(1).join(":").trim() : cleanedMatched;
            const prestationLabel = ({ plaquettes: "le changement des plaquettes de frein", disques: "le changement des disques de frein", "révision": "la révision" })[prestation] || prestation;
            textToSpeak = `D'accord, nous allons faire une demande de rendez-vous. Le tarif pour ${prestationLabel} est de ${pricePart}. Les horaires sont ${garageHoursText || "les horaires du garage"}. Quel jour vous conviendrait le mieux ?`;
            console.warn("🛡️ Correction serveur appliquée (tarif/horaires sans appel outil):", { prestation, matched: cleanedMatched.substring(0, 100) });
          }
        }
      }
    }
    if (textToSpeak !== clean && LOG_TTS) console.log("[TTS-ENQUEUE] Ajout question de suivi (réponse sans ?):", textToSpeak.substring(clean.length).trim());
    const normalizedForCompare = textToSpeak.toLowerCase()
      .replace(/['']/g, "'") // Normaliser les apostrophes
      .replace(/\s+/g, " ") // Normaliser les espaces multiples
      .replace(/[.,!?;:]/g, "") // Supprimer la ponctuation
      .trim();
    const now = nowMs();
    if (!allowWithoutUser) {
      const hasRecentUserSpeech = lastCommittedAt > 0 && (now - lastCommittedAt) <= ASSISTANT_RESPONSE_WINDOW_MS;
      const noValidUserYet = lastCommittedAt === 0; // aucun transcript valide → première réponse après accueil, on autorise
      const allowTts = hasRecentUserSpeech || noValidUserYet;
      if (!allowTts) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: pas de parole utilisateur récente (lastCommittedAt=${lastCommittedAt}, timeSince=${lastCommittedAt > 0 ? now - lastCommittedAt : 'N/A'})`);
        const timeSinceCommit = lastCommittedAt > 0 ? now - lastCommittedAt : -1;
        const expired = lastCommittedAt > 0 && timeSinceCommit > ASSISTANT_RESPONSE_WINDOW_MS;
        return;
      }
      if (lastSpokenCommitAt && lastCommittedAt && lastSpokenCommitAt === lastCommittedAt) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: déjà parlé pour ce commit`, { lastCommittedAt });
        return;
      }
    }
    const calculateSimilarity = (text1, text2) => {
      const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words1.length === 0 || words2.length === 0) return 0;
      const commonWords = words1.filter(w => words2.includes(w));
      return commonWords.length / Math.max(words1.length, words2.length);
    };
    if (responseId) {
      const prev = spokenResponseIds.get(responseId);
      if (prev) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: responseId déjà parlé`, { responseId, source });
        return;
      }
    }
    if (!ws.__processingTexts) ws.__processingTexts = new Set();
    recentAssistantTexts = recentAssistantTexts.filter((t) => (now - t.ts) < 60_000);
    const skipRepetitionForUnInstant = source === "function_call_fallback" && /un instant/i.test(textToSpeak);
    if (ws.__processingTexts.has(normalizedForCompare) && !skipRepetitionForUnInstant) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] BLOQUÉ: texte en cours de traitement (race condition évitée)`, textToSpeak.substring(0, 120));
        if (LOG_VERBOSE) console.log(`🚨 REPETITION BLOQUÉE (en cours) [source: ${source}]:`, textToSpeak.substring(0, 80));
      }
      return;
    }
    const foundInRecentExact = recentAssistantTexts.some((t) => t.text === normalizedForCompare);
    const foundInRecentSimilar = recentAssistantTexts.some((t) => {
      const similarity = calculateSimilarity(t.text, normalizedForCompare);
      const threshold = normalizedForCompare.length < 30 ? 0.6 : normalizedForCompare.length >= 50 ? 0.55 : 0.7;
      return similarity > threshold;
    });
    const foundInRecentContains = recentAssistantTexts.some((t) => {
      if (normalizedForCompare.length < 30) return false;
      return t.text.includes(normalizedForCompare) || normalizedForCompare.includes(t.text);
    });
    const foundInRecent = foundInRecentExact || foundInRecentSimilar || foundInRecentContains;
    if (foundInRecent && !skipRepetitionForUnInstant) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] BLOQUÉ: texte déjà prononcé récemment (exact=${foundInRecentExact}, similar=${foundInRecentSimilar}, contains=${foundInRecentContains})`, textToSpeak.substring(0, 120));
        if (LOG_VERBOSE) console.log(`🚨 REPETITION BLOQUÉE (déjà prononcé) [source: ${source}]:`, textToSpeak.substring(0, 80));
      }
      return;
    }
    recentAssistantTexts.push({ text: normalizedForCompare, ts: now });
    if (!ws.__processingTexts) ws.__processingTexts = new Set();
    ws.__processingTexts.add(normalizedForCompare);
    setTimeout(() => { ws.__processingTexts.delete(normalizedForCompare); }, 60_000);
    if (premiumTtsLastText && !skipRepetitionForUnInstant) {
      const lastNormalized = normalizeFrenchTtsText(premiumTtsLastText).toLowerCase()
        .replace(/['']/g, "'") // Normaliser les apostrophes
        .replace(/\s+/g, " ") // Normaliser les espaces multiples
        .replace(/[.,!?;:]/g, "") // Supprimer la ponctuation
        .trim();
      const isExactMatch = lastNormalized === normalizedForCompare;
      if (isExactMatch) {
        if (LOG_TTS) {
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (identique au précédent) [source: ${source}]:`, textToSpeak.substring(0, 120));
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (lastText):`, premiumTtsLastText.substring(0, 120));
          if (LOG_VERBOSE) {
            console.log(`🚨 REPETITION BLOQUÉE (identique) [source: ${source}]:`, textToSpeak.substring(0, 80));
            console.log(`🚨 lastText:`, premiumTtsLastText.substring(0, 80));
          }
        }
        return;
      }
      if (lastNormalized.includes(normalizedForCompare) && normalizedForCompare.length > 25) {
        if (LOG_TTS) console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (phrase déjà jouée, sous-chaîne du précédent) [source: ${source}]:`, textToSpeak.substring(0, 100));
        return;
      }
      const similarity = calculateSimilarity(lastNormalized, normalizedForCompare);
      const thresholdLast = normalizedForCompare.length < 30 ? 0.6 : normalizedForCompare.length >= 50 ? 0.55 : 0.7;
      if (similarity > thresholdLast) {
        if (LOG_TTS) {
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (similaire à ${Math.round(similarity * 100)}%) [source: ${source}]:`, textToSpeak.substring(0, 120));
          console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (lastText):`, premiumTtsLastText.substring(0, 120));
          if (LOG_VERBOSE) console.log(`🚨 REPETITION BLOQUÉE (similaire ${Math.round(similarity * 100)}%) [source: ${source}]:`, textToSpeak.substring(0, 80));
        }
        return;
      }
    }
    const queueCheck = premiumTtsQueue.map(job => {
      const jobNormalized = normalizeFrenchTtsText(job.text.trim()).toLowerCase()
        .replace(/['']/g, "'") // Normaliser les apostrophes
        .replace(/\s+/g, " ") // Normaliser les espaces multiples
        .replace(/[.,!?;:]/g, "") // Supprimer la ponctuation
        .trim();
      const isExact = jobNormalized === normalizedForCompare;
      const similarity = calculateSimilarity(jobNormalized, normalizedForCompare);
      return { isExact, similarity, jobText: job.text.substring(0, 100) };
    });
    const thresholdQueue = normalizedForCompare.length < 30 ? 0.6 : normalizedForCompare.length >= 50 ? 0.55 : 0.7;
    const foundInQueue = queueCheck.some(q => q.isExact || q.similarity > thresholdQueue);
    if (foundInQueue && !skipRepetitionForUnInstant) {
      if (LOG_TTS) {
        console.log(`[TTS-ENQUEUE] REPETITION BLOQUÉE (déjà dans la queue) [source: ${source}]:`, textToSpeak.substring(0, 120));
        if (LOG_VERBOSE) console.log(`🚨 REPETITION BLOQUÉE (déjà en queue) [source: ${source}]:`, textToSpeak.substring(0, 80));
      }
      return;
    }
    if (OUTPUT_WAIT_FOR_USER_SILENCE && outUserSpeaking) {
      if (interrupt) pendingSpeakQueue = [];
      pendingSpeakQueue.push(textToSpeak);
      return;
    }
    if (interrupt && lastGarageToolOutputAt > 0 && (now - lastGarageToolOutputAt) < 5000 && assistantReplySources.includes(source)) {
      interrupt = false;
      lastGarageToolOutputAt = 0;
      if (LOG_TTS) console.log("[TTS-ENQUEUE] interrupt→false (suite après outil garage, laisser finir phrase)");
    }
    if (interrupt && (!premiumTtsInFlight || source === "consent_refusal")) {
      premiumTtsQueue = [];
      try { premiumTtsAbort?.abort?.(); } catch { /* ignore */ }
      premiumTtsAbort = new AbortController();
      outboundQueue = [];
      outboundQueuedBytes = 0;
    } else if (!premiumTtsAbort) {
      premiumTtsAbort = new AbortController();
    }
    const alreadyInQueue = premiumTtsQueue.some(job => {
      const jobNormalized = normalizeFrenchTtsText(job.text.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim();
      return jobNormalized === normalizedForCompare;
    });
    if (alreadyInQueue) {
      if (LOG_TTS) console.log(`[TTS-ENQUEUE] BLOQUÉ: texte déjà dans la queue (vérification finale)`, textToSpeak.substring(0, 120));
      return;
    }
    ws.__processingTexts.add(normalizedForCompare);
    setTimeout(() => {
      ws.__processingTexts.delete(normalizedForCompare);
    }, 60_000);
    console.log(`[AI-SAYS] ${normalizeFrenchTtsText(textToSpeak)}`);
    // Annuler hangup si l'IA pose une question devis/RDV nécessitant une réponse du client
    const asksForConfirmation = (/\b(est-ce bien correct|est-ce correct)\b/i.test(textToSpeak) && /\b(plaque|immatriculation)\b/i.test(textToSpeak))
      || /\bje prends note de votre demande de devis\b/i.test(textToSpeak)
      || /\bquel jour vous conviendrait\b/i.test(textToSpeak)
      || /\bplutôt le matin ou l'après-midi\b/i.test(textToSpeak);
    if (asksForConfirmation && goodbyeDetected) {
      console.log("🔄 Annulation hangup automatique: l'IA pose une question (devis/RDV) nécessitant une réponse du client");
      goodbyeDetected = false;
      if (goodbyeFallbackTimer) {
        clearTimeout(goodbyeFallbackTimer);
        goodbyeFallbackTimer = null;
      }
    }
    premiumTtsQueue.push({ text: textToSpeak, interrupt, onComplete: onComplete || null });
    premiumTtsLastText = textToSpeak;
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
      console.log(`[TTS-ENQUEUE] TEXTE ENQUEUED:`, textToSpeak.substring(0, 200));
      if (LOG_VERBOSE) console.log(`🚨 TTS enqueued [source: ${source}] queueLen=${premiumTtsQueue.length}:`, textToSpeak.substring(0, 80));
    }
    void drainPremiumTtsQueue();
  }
  function enqueueElevenLabsTts(text, { interrupt = true } = {}) {
    enqueuePremiumTts(text, { interrupt, source: "legacy_elevenlabs" });
  }
  async function drainPremiumTtsQueue() {
    if (premiumTtsDrainInFlight) {
      if (LOG_VERBOSE) console.log(`🔊 drain skipped (premiumTtsDrainInFlight=true, queueLen=${premiumTtsQueue.length})`);
      return;
    }
    premiumTtsDrainInFlight = true;
    try {
      let lastProcessedText = "";
      while (premiumTtsQueue.length > 0) {
        const job = premiumTtsQueue.shift();
        if (!job) continue;
        const jobNormalized = normalizeFrenchTtsText(job.text.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim();
        const lastNormalized = lastProcessedText ? normalizeFrenchTtsText(lastProcessedText.trim()).toLowerCase().replace(/[.,!?;:]/g, "").trim() : "";
        if (lastNormalized && jobNormalized === lastNormalized) {
          console.log(`🔊 drain ignored duplicate: "${job.text.substring(0, 60)}…"`);
          if (LOG_TTS) {
            console.log(`[TTS-DRAIN] IGNORÉ (doublon dans la queue):`, job.text.substring(0, 120));
            console.log(`🔁 drainPremiumTtsQueue ignoré (doublon dans la queue):`, job.text.substring(0, 120));
          }
          continue;
        }
        lastProcessedText = job.text;
        const preview = job.text.substring(0, 70) + (job.text.length > 70 ? "…" : "");
        try {
          const useMinimax = PREMIUM_TTS_PROVIDER === "minimax" || assistantVoice === "minimax_male";
          if (useMinimax) {
            if (LOG_VERBOSE) console.log(`🔊 drain calling speakWithMinimaxNow: "${preview}"`);
            await speakWithMinimaxNow(job.text, { interrupt: false });
          } else if (PREMIUM_TTS_PROVIDER === "elevenlabs") {
            await speakWithElevenLabsNow(job.text, { interrupt: false });
          }
        } catch (drainErr) {
          const drainMsg = drainErr?.message || String(drainErr);
          const isMinimax1000 = /status_code[\"']?\s*:\s*1000|1000.*unknown error/i.test(drainMsg);
          if (isMinimax1000 && PREMIUM_TTS_PROVIDER === "minimax" && !job._minimaxRetried) {
            job._minimaxRetried = true;
            premiumTtsQueue.unshift(job);
            console.log("🔄 Minimax 1000 (retry later) : ré-enqueue pour une seule retentative");
          } else {
            console.error("❌ Erreur TTS dans la file (on continue la suite):", drainMsg);
          }
        }
        if (typeof job.onComplete === "function") {
          try { job.onComplete(); } catch (e) { console.error("TTS onComplete error:", e); }
        }
      }
    } finally {
      premiumTtsDrainInFlight = false;
    }
  }
  async function drainElevenLabsQueue() {
    await drainPremiumTtsQueue();
  }
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
        if (unit === 1) return `${tensMap[tens]}-et-un`;
        return `${tensMap[tens]}-${units[unit]}`;
      }
      if (n2 < 80) {
        const rest = n2 - 60;
        if (rest === 11) return "soixante-et-onze";
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
  function numberToFrenchWordsTts(n) {
    const num = typeof n === "number" ? n : Number(String(n).replace(/\s+/g, ""));
    const raw = numberToFrenchWords(n);
    if (num >= 21 && num <= 99) return raw;
    return raw.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  }
  /** Sanitise le texte envoyé à Minimax TTS pour éviter erreurs 1000/1042 (invisible chars, control chars, longueur). */
  function sanitizeTextForMinimax(text) {
    if (text == null || typeof text !== "string") return "";
    let s = text;
    s = s.replace(/\uFEFF/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    s = s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");
    s = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return "";
    const MAX_MINIMAX_CHARS = 8000;
    if (s.length > MAX_MINIMAX_CHARS) {
      const cut = s.slice(0, MAX_MINIMAX_CHARS);
      const lastSpace = cut.lastIndexOf(" ");
      s = lastSpace > 100 ? cut.slice(0, lastSpace) : cut;
      if (LOG_TTS) console.log("[TTS-MINIMAX] Texte tronqué pour Minimax:", text.length, "->", s.length, "caractères");
    }
    return s;
  }
  function normalizeFrenchTtsText(input) {
    let t = String(input || "").trim();
    if (!t) return "";
    const originalText = t;
    const hasHourPattern = t.match(/\d{1,2}[hH:]\s*\d{1,2}|\d{1,2}\s+heures?\s+\d{1,2}/i);
    const hasHourWords = t.match(/\b(huit|sept|six|cinq|quatre|trois|deux|une)\s+heures?\s+(trois|zéro|zero|\d)/i);
    t = t.replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ");
    t = t.replace(/\.([A-ZÀÂÆÇÉÈÊËÎÏÔÙÛÜŸ])/g, ". $1");
    // Collages TTS horaires: "et14h" → "et quatorze heures", "sonthuit" → "sont huit"
    t = t.replace(/\bet(\d{1,2})[hH]\b/gi, (_, h) => {
      const n = Number(h);
      return "et " + (n === 12 ? "midi" : n === 0 ? "minuit" : numberToFrenchWordsTts(n) + " heures");
    });
    t = t.replace(/\bsont(huit|sept|six|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante)\b/gi, "sont $1");
    // Corriger "cinquante cent" ou "cinquantecent" (tarif 50 à 190) -> "cinquante euros à cent"
    t = t.replace(/\bcinquante\s*cent\s+/gi, "cinquante euros à cent ");
    t = t.replace(/\bcent\s+quatre\s+vingt\s+dix\b/gi, "cent-quatre-vingt-dix");
    t = t.replace(/\bcent\s+quatre\s+vingt\s+(un|deux|trois|quatre|cinq|six|sept|huit|neuf)\b/gi, "cent-quatre-vingt-$1");
    t = t.replace(/\bcent\s+quatre\s+vingt\b/gi, "cent-quatre-vingt");
    t = t.replace(/\bcent\s+(soixante|cinquante|quarante|trente|vingt)\s+(dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf)\b/gi, (_, tens, units) => `cent-${tens}-${units}`);
    t = t.replace(/\bquatre\s+vingt\s+dix\b/gi, "quatre-vingt-dix");
    t = t.replace(/\bquatre\s+vingt\s+(un|deux|trois|quatre|cinq|six|sept|huit|neuf)\b/gi, "quatre-vingt-$1");
    t = t.replace(/\bquatre\s+vingt\b/gi, "quatre-vingt");
    t = t.replace(/\bsoixante\s+dix\s+(neuf|huit|sept|six|cinq|quatre|trois|deux|un)\b/gi, (_, u) => `soixante-dix-${u}`);
    t = t.replace(/\bsoixante\s+(onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf)\b/gi, (_, u) => `soixante-${u}`);
    t = t.replace(/\bsoixante\s+dix\b/gi, "soixante-dix");
    t = t.replace(/\bvingt\s+et\s+un\b/gi, "vingt-et-un");
    t = t.replace(/\btrente\s+et\s+un\b/gi, "trente-et-un");
    t = t.replace(/\bquarante\s+et\s+un\b/gi, "quarante-et-un");
    t = t.replace(/\bcinquante\s+et\s+un\b/gi, "cinquante-et-un");
    t = t.replace(/\bsoixante\s+et\s+un\b/gi, "soixante-et-un");
    t = t.replace(/\bsoixante\s+et\s+onze\b/gi, "soixante-et-onze");
    t = t.replace(/,([a-zàâæçéèêëîïôùûü0-9])/gi, ", $1");
    t = t.replace(/\bpour(\d{1,2})(?=\s|$|h|heures?)/gi, "pour $1");
    t = t.replace(/(^|[\s\.,;:!?])le(\d{1,2})(?=[\s\.,;:!?]|$|[a-zàâæçéèêëîïôùûü])/gi, (_, before, num) => (before || "") + "le " + num);
    t = t.replace(/(^|[\s\.,;:!?])à(\d{1,2})(?=[\s\.,;:!?]|$|h|heures)/gi, (_, before, num) => (before || "") + "à " + num);
    t = t.replace(/(^|[\s\.,;:!?])du(\d{1,2})(?=[\s\.,;:!?]|$|[a-zàâæçéèêëîïôùûü])/gi, (_, before, num) => (before || "") + "du " + num);
    t = t.replace(/(^|[\s\.,;:!?])la(\d{1,2})(?=[\s\.,;:!?]|$|[a-zàâæçéèêëîïôùûü])/gi, (_, before, num) => (before || "") + "la " + num);
    t = t.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(\d{1,2})(?=\s|$|[a-zàâæçéèêëîïôùûü])/gi, "$1 $2");
    t = t.replace(/\b(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(\d{1,2})(?=\s|$|[a-zàâæçéèêëîïôùûü])/gi, "$1 $2");
    const dayToFrench = (d) => { const n = Number(d); return n === 1 ? "premier" : numberToFrenchWordsTts(n); };
    t = t.replace(/\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/gi, (_, j, d, m) => `${j} ${dayToFrench(d)} ${m}`);
    t = t.replace(/\ble\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/gi, (_, d, m) => `le ${dayToFrench(d)} ${m}`);
    t = t.replace(/lors\s+du\s+de\s+vis/gi, "lors du devis");
    t = t.replace(/du\s+de\s+vis/gi, "du devis");
    t = t.replace(/de\s+vis/gi, "devis");
    t = t.replace(/de\s+ux/gi, "deux");
    t = t.replace(/heures\s+et\s+de\s+mie/gi, "heures et demie");
    t = t.replace(/et\s+de\s+mie/gi, "et demie");
    t = t.replace(/de\s+mie/gi, "demie");
    t = t.replace(/heures\s+demie/gi, "heures et demie");
    t = t.replace(/à16(?=\s|$)/gi, "à 16");
    t = t.replace(/àseize/gi, "à seize");
    t = t.replace(/de\s+mande/gi, "demande");
    t = t.replace(/\b(de|à|est|sont|coûte|coûtent)(\d{1,4})\b/g, (_, det, n) => `${det} ${n}`);
    t = t.replace(/\bà(seize|huit|dix|neuf|quinze|vingt|trente|quarante|cinquante|soixante|sept|six|cinq|quatre|trois|deux|une?)\b/gi, (_, w) => `à ${w}`);
    t = t.replace(/\best[- ]ce[- ]bien\b/gi, "est-ce bien");
    t = t.replace(/\benviron(?=une?\b)/gi, "environ ");
    t = t.replace(/\best\s+ce\b/gi, "est-ce");
    t = t.replace(/([a-zàâçéèêëîïôûùüÿœ])(\d{1,2})\s*heures?\s*(\d{2})\b/gi, (_, prefix, h, m) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = hoursWord;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} et quart`;
      } else if (minutesNum === 45) {
        const nextHour = hoursNum === 23 ? 0 : hoursNum + 1;
        const nextHourWord = nextHour === 0 ? "minuit" : nextHour === 1 ? "une heure" : `${numberToFrenchWordsTts(nextHour)} heures`;
        timeExpression = `${nextHourWord} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${minutesWord}`;
      }
      return `${prefix} ${timeExpression}`;
    });
    const beforeReplace1 = t;
    t = t.replace(/(\d{1,2})\s*[hH:]\s*(\d)\s+(\d)\b/g, (_, h, m1, m2) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m1 + m2);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = hoursWord;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} et quart`;
      } else if (minutesNum === 45) {
        const nextHour = hoursNum === 23 ? 0 : hoursNum + 1;
        const nextHourWord = nextHour === 0 ? "minuit" : nextHour === 1 ? "une heure" : `${numberToFrenchWordsTts(nextHour)} heures`;
        timeExpression = `${nextHourWord} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/(\d{1,2})\s*[hH:]\s*(\d{2})\b/g, (_, h, m) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = hoursWord;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} et quart`;
      } else if (minutesNum === 45) {
        const nextHour = hoursNum === 23 ? 0 : hoursNum + 1;
        const nextHourWord = nextHour === 0 ? "minuit" : nextHour === 1 ? "une heure" : `${numberToFrenchWordsTts(nextHour)} heures`;
        timeExpression = `${nextHourWord} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\b(\d{1,2})\s+heures?\s+(\d)\s+(\d)\b/gi, (_, h, m1, m2) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m1 + m2);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = hoursWord;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} et quart`;
      } else if (minutesNum === 45) {
        const nextHour = hoursNum === 23 ? 0 : hoursNum + 1;
        const nextHourWord = nextHour === 0 ? "minuit" : nextHour === 1 ? "une heure" : `${numberToFrenchWordsTts(nextHour)} heures`;
        timeExpression = `${nextHourWord} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/(\d{1,2})\s*heures?\s*(\d{2})\b/gi, (_, h, m) => {
      const hoursNum = Number(h);
      const minutesNum = Number(m);
      const hoursWord = hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = hoursWord;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} et quart`;
      } else if (minutesNum === 45) {
        const nextHour = hoursNum === 23 ? 0 : hoursNum + 1;
        const nextHourWord = nextHour === 0 ? "minuit" : nextHour === 1 ? "une heure" : `${numberToFrenchWordsTts(nextHour)} heures`;
        timeExpression = `${nextHourWord} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s*heures?\s*(\d{2})\b/gi, (_, hoursWord, m) => {
      const minutesNum = Number(m);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(\d)\s+(\d)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesNum = Number(m1 + m2);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\bheures\s+(un|deux|trois|quatre|cinq|six|sept|huit|neuf|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante):00\b/gi, "heures $1");
    t = t.replace(/\b(\d{1,2})\s*[hH]\b/gi, (_, h) => {
      const hoursNum = Number(h);
      return hoursNum === 1 ? "une heure" : `${numberToFrenchWordsTts(hoursNum)} heures`;
    });
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(un|deux|trois|quatre|cinq|six|sept|huit|neuf|zéro|zero)\s+(un|deux|trois|quatre|cinq|six|sept|huit|neuf|zéro|zero)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesMap = { "un": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "sept": 7, "huit": 8, "neuf": 9, "zéro": 0, "zero": 0 };
      const minutesNum = (minutesMap[m1.toLowerCase()] || 0) * 10 + (minutesMap[m2.toLowerCase()] || 0);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    const beforeHourFix = t;
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(\d)\s+(\d)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesNum = Number(m1 + m2);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(trois|zero|zéro)\s+(zéro|zero)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesMap = { "trois": 3, "zéro": 0, "zero": 0 };
      const minutesNum = (minutesMap[m1.toLowerCase()] || 0) * 10 + (minutesMap[m2.toLowerCase()] || 0);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\b(une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante|soixante-dix|quatre-vingt|quatre-vingt-dix)\s+heures?\s+(\d)\s+(\d)\b/gi, (_, hoursWord, m1, m2) => {
      const minutesNum = Number(m1 + m2);
      const hoursForm = hoursWord === "une" ? "heure" : "heures";
      let timeExpression = "";
      if (minutesNum === 0) {
        timeExpression = `${hoursWord} ${hoursForm}`;
      } else if (minutesNum === 30) {
        timeExpression = `${hoursWord} ${hoursForm} et demie`;
      } else if (minutesNum === 15) {
        timeExpression = `${hoursWord} ${hoursForm} et quart`;
      } else if (minutesNum === 45) {
        timeExpression = `${hoursWord} ${hoursForm} moins le quart`;
      } else {
        const minutesWord = numberToFrenchWordsTts(minutesNum);
        timeExpression = `${hoursWord} ${hoursForm} ${minutesWord}`;
      }
      return timeExpression;
    });
    t = t.replace(/\benviron(\d)/gi, "environ $1");
    t = t.replace(/\benviron\s*(\d{1,4})\s*€/gi, "(environ $1 €)");
    t = t.replace(/\bcent\s+quatre\s+vingt\s+dix\s+(?:€|euros?)\b/gi, "190 euros");
    const euroPhraseToDigit = { "cent-quatre-vingt-dix": 190, "cent-quatre-vingt": 180, "quatre-vingt-dix": 90, "quatre-vingt": 80, "soixante-dix": 70 };
    for (const [phrase, num] of Object.entries(euroPhraseToDigit)) {
      t = t.replace(new RegExp(`\\b${phrase.replace(/-/g, "\\-")}\\s+(?:€|euros?)\\b`, "gi"), `${num} euros`);
    }
    t = t.replace(/\bentre\s+(\d{1,4})\s+et\s+(\d{1,4})\s+(?:€|euros?)\b/gi, (_, a, b) => `entre ${a} et ${b} euros`);
    t = t.replace(/\bde\s+(\d{1,4})\s+à\s+(\d{1,4})\s+(?:€|euros?)\b/gi, (_, a, b) => `de ${a} à ${b} euros`);
    t = t.replace(/\b(de|à|est|sont|tarif|prix|coût|montant|facture)\s+(\d(?:\s+\d){1,4})\s+(?:€|euros?)\b/gi, (_, prefix, n) => {
      const compact = String(n).replace(/\s+/g, "");
      return `${prefix} ${numberToFrenchWordsTts(compact)} euros`;
    });
    t = t.replace(/\b(\d(?:\s+\d){1,4})\s+(?:€|euros?)\b/gi, (_, n) => {
      const compact = String(n).replace(/\s+/g, "");
      const result = `${numberToFrenchWordsTts(compact)} euros`;
      return result;
    });
    t = t.replace(/\b(\d(?:\s+\d){1,4})\s*€\b/gi, (_, n) => {
      const compact = String(n).replace(/\s+/g, "");
      return `${numberToFrenchWordsTts(compact)} euros`;
    });
    t = t.replace(/\b(\d(?:\s+\d){1,4})[.,](\d{1,2})\s*(?:€|euros?)\b/gi, (_, n, d) => {
      const major = numberToFrenchWordsTts(String(n).replace(/\s+/g, ""));
      const minor = numberToFrenchWordsTts(d);
      return `${major} euros ${minor}`;
    });
    t = t.replace(/\b(\d{1,4})euros?\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} euros`);
    t = t.replace(/\b(\d{1,4})\s+(?:€|euros?)\b/gi, (_, n) => {
      const inRange = /\b(entre\s+\d+\s+et|de\s+\d+\s+à)\s+\d+\s+euros?/i.test(t) && (t.includes(` et ${n} euros`) || t.includes(` à ${n} euros`));
      if (inRange) return `${n} euros`;
      const result = `${numberToFrenchWordsTts(n)} euros`;
      return result;
    });
    t = t.replace(/\b(\d{1,4})€\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} euros`);
    t = t.replace(/\b(\d{1,4})\s*€\b/gi, (_, n) => `${numberToFrenchWordsTts(n)} euros`);
    t = t.replace(/\b(\d{1,4})[.,](\d{1,2})euros?\b/gi, (_, n, d) => {
      const major = numberToFrenchWordsTts(n);
      const minor = numberToFrenchWordsTts(d);
      return `${major} euros ${minor}`;
    });
    t = t.replace(/\b(\d{1,4})[.,](\d{1,2})\s*(?:€|euros?)\b/gi, (_, n, d) => {
      const major = numberToFrenchWordsTts(n);
      const minor = numberToFrenchWordsTts(d);
      return `${major} euros ${minor}`;
    });
    t = t.replace(/\b(de|à|est|sont|tarif|prix|coût|montant|facture)\s+(\d{1,4})\s+(?:€|euros?)\b/gi, (_, prefix, n) => {
      return `${prefix} ${numberToFrenchWordsTts(n)} euros`;
    });
    t = t.replace(/\b(\d{1,4})\s+(?:pour|de|tarif|prix|coût|montant|facture|à|est|sont)(?!\s+\d{1,4}\s+(?:€|euros?))\b/gi, (_, n) => {
      return `${numberToFrenchWordsTts(n)}`;
    });
    t = t.replace(/\b(de|à|est|sont)\s+(\d{1,4})\s+(?:€|euros?)\b/gi, (_, prefix, n) => {
      return `${prefix} ${numberToFrenchWordsTts(n)} euros`;
    });
    t = t.replace(/\b(tarif|prix|coût|montant|facture)\s+(?:de|à|est|sont)?\s*(\d{1,4})\s+(?:€|euros?)\b/gi, (_, context, n) => {
      return `${context} de ${numberToFrenchWordsTts(n)} euros`;
    });
    t = t.replace(/\b(de|à|est|sont)(\d{1,4})€/gi, (_, det, n) => {
      return `${det} ${n}€`;
    });
    t = t.replace(/\b(de|à|est|sont)(\d{1,4})\s+euros?\b/gi, (_, det, n) => {
      return `${det} ${n} euros`;
    });
    t = t.replace(/\bentre(\d{1,4})\b/gi, (_, n) => `entre ${n}`);
    t = t.replace(/\bet(\d{1,4})\b/gi, (_, n) => `et ${n}`);
    t = t.replace(/\b([A-Z]{2})[\s-]?(\d(?:\s+\d){0,3}|\d{2,4})[\s-]?([A-Z]{2})\b/gi, (_, letters1, numbers, letters2) => {
      const compact = String(numbers).replace(/\s+/g, "");
      const num = Number(compact);
      if (num >= 0 && num <= 9999) {
        const numbersInWords = numberToFrenchWordsTts(num).replace(/\s+/g, "-");
        return `${letters1} ${numbersInWords} ${letters2}`;
      }
      return `${letters1} ${numbers} ${letters2}`;
    });
    t = t.replace(/\b(\d(?:\s+\d){1,5})\b/g, (m, offset, string) => {
      const afterMatch = string.slice(offset + m.length, offset + m.length + 20);
      const beforeMatch = string.slice(Math.max(0, offset - 5), offset);
      if (/\s*(?:€|euros?)/i.test(afterMatch)) {
        return m;
      }
      if (/heure/i.test(afterMatch)) return m;
      if (/[A-Z]{2}\s*$/i.test(beforeMatch) && /^\s*[A-Z]{2}/i.test(afterMatch)) {
        return m;
      }
      return m.replace(/\s+/g, "");
    });
    t = t.replace(/\b(\d{1,2}(?:\s+\d){0,3})(\s*)(?:€|euros?)\b/gi, (_, n, space) => {
      const compact = String(n).replace(/\s+/g, "");
      return `${compact}${space}euros`;
    });
    t = t.replace(/\bentre\s+(\d{1,4})\s+et\s+(\d{1,4})\s+euros?\b/gi, (_, a, b) => `de ${a} euros à ${b} euros`);
    t = t.replace(/\best-ce que\b/gi, "est ce que");
    t = t.replace(/\best ce que\b/gi, "est ce que");
    t = t.replace(/\bRDV\b/gi, "rendez-vous");
    t = t.replace(/\bappointment\b/gi, "rendez-vous");
    t = t.replace(/\bappointments\b/gi, "rendez-vous");
    t = t.replace(/\ble\s+SMS\b/gi, "le message");
    t = t.replace(/\bun\s+SMS\b/gi, "un message");
    t = t.replace(/\bdes\s+SMS\b/gi, "des messages");
    t = t.replace(/\bpar\s+SMS\b/gi, "par message");
    t = t.replace(/\bvia\s+SMS\b/gi, "par message");
    t = t.replace(/\ben\s+SMS\b/gi, "par message");
    t = t.replace(/\bl['']SMS\b/gi, "le message");
    t = t.replace(/\bSMS\b/gi, "un message");
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
  const BARGE_IN_ENABLED = (process.env.BARGE_IN_ENABLED ?? "false").toLowerCase() === "true";
  const TWILIO_SPEECH_THRESHOLD = Number(process.env.BARGE_IN_THRESHOLD ?? "15000"); // Seuil élevé pour éviter les faux positifs
  const BARGE_IN_FRAMES = Number(process.env.BARGE_IN_FRAMES ?? "35"); // ~700ms de parole continue nécessaire
  let twilioSpeechFrames = 0;
  const INPUT_GATE_ENABLED = (process.env.INPUT_GATE_ENABLED ?? (PIPELINE_MODE === "realtime" ? "true" : "false")).toLowerCase() === "true";
  const INPUT_SPEECH_THRESHOLD = Number(process.env.INPUT_SPEECH_THRESHOLD ?? "600"); // 600: sensible (recommandé si l'utilisateur doit répéter); 900–1200: plus strict
  const INPUT_SPEECH_FRAMES = Number(process.env.INPUT_SPEECH_FRAMES ?? "10"); // Augmenté de 6 à 10 (~200ms au lieu de 120ms)
  const INPUT_SILENCE_THRESHOLD = Number(process.env.INPUT_SILENCE_THRESHOLD ?? "450");
  const INPUT_SILENCE_FRAMES = Number(process.env.INPUT_SILENCE_FRAMES ?? (PIPELINE_MODE === "realtime" ? "38" : "20")); // ~760ms en realtime: laisser finir la phrase
  let inputSpeechFrames = 0;
  let inputSilenceFrames = 0;
  let inputActive = false; // on est en train d'envoyer une "prise de parole" à OpenAI
  let bytesSinceInputStart = 0;
  let lastInputAudioLevel = 0; // Niveau audio moyen de la dernière frame pour filtrer les faux positifs OpenAI
  let lastInputCommitAt = 0;
  const LOCAL_COMMIT_ENABLED = (process.env.LOCAL_COMMIT_ENABLED ?? "false").toLowerCase() === "true";
  const INPUT_SUPPRESS_WHILE_TALKING = (process.env.INPUT_SUPPRESS_WHILE_TALKING ?? "true").toLowerCase() === "true";
  const INPUT_SUPPRESS_BACKLOG_FRAMES = Number(process.env.INPUT_SUPPRESS_BACKLOG_FRAMES ?? "2"); // ~40ms d'audio sortant
  const INPUT_SUPPRESS_OVERRIDE_THRESHOLD = Number(
    process.env.INPUT_SUPPRESS_OVERRIDE_THRESHOLD ?? String(Math.max(2500, Math.floor(INPUT_SPEECH_THRESHOLD * 1.5))),
  );
  const REALTIME_TTS_MODE = (process.env.REALTIME_TTS_MODE ?? "openai").toLowerCase();
  const REALTIME_USE_ELEVEN =
    PIPELINE_MODE === "realtime" &&
    PREMIUM_TTS_ENABLED &&
    (PREMIUM_TTS_PROVIDER === "elevenlabs" || PREMIUM_TTS_PROVIDER === "minimax");
  const REALTIME_ELEVEN_CHUNKING_ENABLED = (process.env.REALTIME_ELEVEN_CHUNKING_ENABLED ?? "false").toLowerCase() === "true";
  const REALTIME_ELEVEN_CHUNK_MIN_CHARS = Number(process.env.REALTIME_ELEVEN_CHUNK_MIN_CHARS ?? "40");
  const REALTIME_ELEVEN_CHUNK_MAX_CHARS = Number(process.env.REALTIME_ELEVEN_CHUNK_MAX_CHARS ?? "240");
  function requestResponseCreate(reason) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    const now = nowMs();
    if (responseInProgress) return;
    const skipDebounce = reason === "after_function_call_output";
    if (!skipDebounce && (now - lastResponseCreateRequestedAt) < RESPONSE_CREATE_DEBOUNCE_MS) return;
    lastResponseCreateRequestedAt = now;
    try {
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
      outboundQueue = [];
      outboundQueuedBytes = 0;
      console.log("✋ Barge-in: response.cancel + purge outbound.");
    } catch (err) {
      console.error("❌ Erreur response.cancel:", err);
    }
  }
  function enqueueOutboundMulaw(buf) {
    if (!buf || buf.length === 0) return;
    const SOFT_MAX_BACKLOG_BYTES = 160 * 500; // ~10s @ 20ms
    const HARD_MAX_BACKLOG_BYTES = 160 * 1500; // ~30s @ 20ms
    if (outboundQueuedBytes > HARD_MAX_BACKLOG_BYTES) {
      while (outboundQueue.length > 0 && outboundQueuedBytes > SOFT_MAX_BACKLOG_BYTES) {
        const head = outboundQueue.shift();
        if (!head) break;
        outboundQueuedBytes -= head.length;
        droppedOutboundBytes += head.length;
      }
      if (LOG_VERBOSE) console.log("🗑️ Outbound audio drop (HARD backlog):", {
        outboundQueuedBytes,
        droppedOutboundBytes,
      });
    } else if (outboundQueuedBytes > SOFT_MAX_BACKLOG_BYTES && Math.random() < 0.05) {
      if (LOG_VERBOSE) console.log("⏳ Outbound backlog (no drop):", {
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
  async function connectToOpenAI() {
    let connectionTimeout = null;
    let connectionTimeoutTriggered = false;
    if (!OPENAI_API_KEY) {
      console.error("❌ OpenAI API key manquante");
      return;
    }
    try {
      console.log("🔌 Tentative de connexion à OpenAI Realtime API...");
      const realtimeModel = "gpt-4o-mini-realtime-preview"; // gpt-4o-mini = version mini, moins cher, plus rapide
      const openaiUrl =
        `wss://api.openai.com/v1/realtime?model=${realtimeModel}&input_audio_format=pcm16&output_audio_format=pcm16`;
      console.log("☎️ Modèle Realtime utilisé:", realtimeModel);
      console.log("🔌 URL OpenAI:", openaiUrl.replace(/Bearer\s+\S+/, "Bearer ***"));
      console.log("🔌 OPENAI_API_KEY présente:", !!OPENAI_API_KEY);
      console.log("🔌 OPENAI_API_KEY longueur:", OPENAI_API_KEY ? OPENAI_API_KEY.length : 0);
      console.log("🔌 OPENAI_API_KEY préfixe:", OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 7) : "N/A");
      if (!OPENAI_API_KEY || OPENAI_API_KEY.trim().length === 0) {
        console.error("❌ OPENAI_API_KEY est vide ou manquante !");
        return;
      }
      const trimmedKey = OPENAI_API_KEY.trim();
      if (!trimmedKey.startsWith("sk-")) {
        console.error("❌ OPENAI_API_KEY ne commence pas par 'sk-' - format invalide !");
        console.error("❌ Préfixe reçu:", trimmedKey.substring(0, 10));
        return;
      }
      if (openaiWs) {
        try {
          openaiWs.removeAllListeners();
          if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
            openaiWs.close();
          }
        } catch (e) {
        }
      }
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
      const OPENAI_WS_TIMEOUT_MS = Number(process.env.OPENAI_WS_CONNECTION_TIMEOUT_MS) || 15000;
      connectionTimeout = setTimeout(() => {
        if (openaiWs && openaiWs.readyState !== WebSocket.OPEN) {
          connectionTimeoutTriggered = true;
          console.error(`❌ Timeout connexion OpenAI WebSocket (${OPENAI_WS_TIMEOUT_MS / 1000}s)`);
          console.error("❌ État WebSocket:", openaiWs.readyState, "(0=CONNECTING, 1=OPEN)");
          if (openaiWs) {
            try {
              openaiWs.close();
            } catch (e) {
            }
          }
        }
      }, OPENAI_WS_TIMEOUT_MS);
      openaiWs.on("open", async () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        console.log("✅ Connecté à OpenAI Realtime API");
        console.log("☎️ Modèle Realtime:", realtimeModel);
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
        const ASSISTANT_PERSONA = (process.env.ASSISTANT_PERSONA ?? "mecanicien").toLowerCase();
        const rawGarageName = String(garageName || "AutoGuru").trim();
        const garageLabel = /^garage\b/i.test(rawGarageName) ? rawGarageName : `Garage ${rawGarageName}`;
        const placeLabel = effectiveSector === "restaurant"
          ? (/^restaurant\b/i.test(rawGarageName) ? rawGarageName : `Restaurant ${rawGarageName}`)
          : garageLabel;
        const modeLine =
          appointmentMode === "none"
            ? "Mode rendez-vous: aucun (tu ne proposes pas de RDV, tu prends un message)."
            : appointmentMode === "internal"
              ? `Mode rendez-vous: interne (tu peux proposer un créneau, mais tu confirmes UNIQUEMENT après validation explicite du client). RÈGLE ABSOLUE - TARIF vs RDV: Une demande de TARIF (« quel est le tarif », « combien coûte », « le prix de », « c'est combien pour ») n'est PAS une demande de RDV. Tu donnes UNIQUEMENT le tarif, puis "Avez-vous besoin d'autre chose ?". Tu NE lances JAMAIS la procédure RDV dans ce cas. NE répète JAMAIS le montant après l'avoir dit. RÈGLE ABSOLUE - HORAIRES/INFO UNIQUEMENT: Si le client demande UNIQUEMENT les horaires, les tarifs ou une information (sans avoir dit qu'il veut un rendez-vous), tu réponds à sa question puis "Avez-vous besoin d'autre chose ?". Ne dis JAMAIS "Souhaitez-vous prendre rendez-vous ?" ni "Quel jour vous conviendrait le mieux ?" dans ce cas. EXEMPLE: Client "Quel est le tarif des plaquettes ?" → tu donnes le tarif (ex. "cent quarante neuf euros"), puis "Avez-vous besoin d'autre chose ?". UNE SEULE annonce du tarif. Tu NE redis PAS le montant. "Quel jour vous conviendrait le mieux ?" se dit UNIQUEMENT quand le client vient de répondre OUI à "Vous voulez prendre rendez-vous ?". Tu ne confirmes le rendez-vous QUE si le client donne son consentement explicite. CRITIQUE: Si le client décrit un problème, tu DOIS D'ABORD poser des questions (depuis quand, autres symptômes) AVANT de proposer un diagnostic et de demander "Vous voulez prendre rendez-vous ?".${garageClosed ? " IMPORTANT: Si le garage est fermé, tu NE peux PAS prendre de rendez-vous. Tu dis que le garage est fermé et que quelqu'un rappellera." : ""}`
              : "Mode rendez-vous: demande (tu NE confirmes PAS de RDV, tu prends une demande). RÈGLE ABSOLUE - TARIF vs RDV: Une demande de TARIF (« quel est le tarif », « combien coûte », « le prix de », « c'est combien pour », « je voudrais savoir le prix ») n'est PAS une demande de RDV. Tu donnes UNIQUEMENT le tarif (get_garage_pricing), puis « Avez-vous besoin d'autre chose ? ». Tu NE lances JAMAIS la procédure RDV dans ce cas. Une demande de RDV = le client dit qu'il veut PRENDRE rendez-vous, RÉSERVER ou FIXER un créneau. RÈGLE ABSOLUE - TARIF/HORAIRES SEULS: Si le client demande UNIQUEMENT le tarif ou les horaires (sans avoir dit qu'il veut un rendez-vous), appelle get_garage_pricing, donne le tarif (UNE SEULE FOIS, ne répète jamais le montant après), puis « Avez-vous besoin d'autre chose ? ». Ne dis JAMAIS « Souhaitez-vous prendre rendez-vous ? » ni « Quel jour vous conviendrait le mieux ? » ni « Nous allons faire une demande de rendez-vous » dans ce cas — sauf si le client a explicitement demandé un RDV. Ne demande JAMAIS l'heure souhaitée au client : demande uniquement le jour puis « Plutôt le matin ou l'après-midi ? ». Si le client donne une date précise (ou date et heure), dis : « C'est une demande auprès du garage, tout sera confirmé quand le garage vous rappellera ; je prends bien cette date en compte pour la communiquer au garage. » Puis confirmation de la plaque si besoin. Après avoir noté jour/créneau/plaque, dis : « C'est une demande de rendez-vous, le garage vous rappellera pour confirmer. » puis « Avez-vous besoin d'autre chose ? ».";
        const consentLine =
          consentRequired && !consentGiven
            ? "RÈGLE ABSOLUE - CONSENTEMENT: Dès le début de l'appel, annonce UNIQUEMENT: 'Cet appel est enregistré pour préparer votre arrivée au garage. Pour continuer, dites : Oui je suis d'accord. Sinon raccrochez si vous refusez.' Puis TU T'ARRÊTES et tu ATTENDS la réponse du client. Tu ne dis RIEN d'autre avant qu'il ait accepté ou refusé. Si le client dit oui je suis d'accord, d'accord ou ok: NE DIS RIEN — la salutation 'Bonjour Monsieur/Madame [nom], en quoi puis-je vous aider ?' est jouée automatiquement. Attends ensuite la question du client. Si le client refuse, tu dis au revoir et tu raccroches. Si le client dit autre chose (ex: il décrit un problème sans avoir accepté), tu réponds UNIQUEMENT: 'Pour continuer, dites : Oui je suis d'accord. Sinon raccrochez si vous refusez.' Tu ne traites aucune autre demande tant qu'il n'a pas accepté ou refusé. Ne demande le consentement QU'UNE SEULE FOIS."
            : consentRequired && consentGiven
            ? "Consentement enregistrement: déjà donné par le client au début de l'appel. INTERDICTION ABSOLUE: Ne redemande JAMAIS le consentement. Ne dis JAMAIS 'Cet appel est enregistré' ni 'Pour continuer, dites : Oui je suis d'accord' — ces phrases sont INTERDITES, le client a déjà accepté. Réponds normalement aux demandes (tarifs, RDV, devis, etc.)."
            : "Consentement enregistrement: non requis.";
        availableAppointmentSlotsLine = "";
        if (appointmentMode === "internal") {
          const slots = await fetchAvailableAppointmentSlots();
          if (slots.length > 0) {
            const pretty = slots
              .slice(0, 12)
              .map((s) => {
                const d = new Date(s.date + "T12:00:00");
                const dateStr = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const hourNum = parseInt(s.time.slice(0, 2), 10);
                const period = hourNum < 12 ? " (matin)" : " (après-midi)";
                return `${dateStr} à ${s.time}${period}`;
              })
              .join(" ; ");
            availableAppointmentSlotsLine = `Créneaux disponibles (planning du garage): ${pretty}. Tu DOIS proposer UNIQUEMENT des créneaux de cette liste, en utilisant EXACTEMENT cette formulation (jour + date + heure). Matin = avant 12h, après-midi = 12h et après. Ne dis JAMAIS "il n'y a pas de créneau disponible" sans avoir vérifié TOUS les créneaux de la liste pour le jour et le créneau (matin/après-midi) demandés. Ne invente jamais une date ni un jour de la semaine.`;
          } else {
            availableAppointmentSlotsLine = "Calendrier du garage libre (aucun créneau déjà réservé). Tu DOIS proposer des créneaux selon les horaires d'ouverture du garage (section Horaires d'ouverture ci-dessus). Utilise la date du jour (section [Référence interne] Aujourd'hui...) pour proposer des dates concrètes (ex: mercredi 11 février à 8h30, jeudi 12 février le matin). Ne dis JAMAIS que le garage est fermé un jour d'ouverture ni qu'il n'y a pas de créneau disponible. Quand le client dit un jour (ex: jeudi, vendredi), accepte ce jour et propose un créneau (ex: 8h30 ou 9h) sur ce jour.";
          }
        }
        const callStartIsoVal = callStartIso || "";
        const nowForPrompt = (callStartIsoVal && !isNaN(new Date(callStartIsoVal).getTime())) ? new Date(callStartIsoVal) : new Date();
        const todayDateLine = `[Référence interne] Aujourd'hui nous sommes ${nowForPrompt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (date et heure de début d'appel). Utilise cette date pour raisonner (demain, créneaux, horaires, etc.) et pour indiquer le bon jour de la semaine quand tu donnes une date au client. Ne dis JAMAIS cette phrase au client au début de l'appel. Ne donne la date du jour au client QUE s'il demande explicitement (ex: "quelle date sommes-nous ?", "c'est quel jour aujourd'hui ?", "on est le combien ?").`;
        const hoursPolicyLine = `Horaires: l'assistant répond 24h/24 et 7j/7 pour vous aider. Les horaires du garage sont obtenus par l'outil get_opening_hours quand tu en as besoin.`;
        const closedInfoLine = garageClosed
          ? `GARAGE FERMÉ (${garageClosedReason || "closed"}): le garage est actuellement fermé. ${garageClosedText || ""} Si le client demande à être transféré, à parler à un humain ou à quelqu'un du garage, tu DOIS dire exactement: "Le garage est actuellement fermé mais je peux gérer votre demande." Puis propose un rappel si besoin. Tu ne transfères JAMAIS quand le garage est fermé (tu n'as pas l'outil transfer_to_garage dans ce cas).`
          : "Info horaires (interne): garage indiqué ouvert.";
        const completMidiSoirLine = (lunchFullToday || dinnerFullToday)
          ? `COMPLET MIDI/SOIR: ${lunchFullToday ? "Si le client demande une réservation pour le service du midi (déjeuner) du jour même, tu DOIS dire exactement: \"Nous sommes complets actuellement pour le service du midi aujourd'hui.\" Puis propose une autre date ou le service du soir. " : ""}${dinnerFullToday ? "Si le client demande une réservation pour le service du soir (dîner) du jour même, tu DOIS dire exactement: \"Nous sommes complets actuellement pour le service du soir aujourd'hui.\" Puis propose une autre date ou le service du midi." : ""}`
          : "";
        const transferLine = allowTransfer
          ? "TRANSFERT VERS LE GARAGE: activé. AVANT d'appeler transfer_to_garage, tu DOIS appeler get_opening_hours. Si le résultat indique 'État actuel: le garage est actuellement FERMÉ', ne transfère PAS et dis: 'Le garage est actuellement fermé mais je peux gérer votre demande. Souhaitez-vous que le garage vous rappelle ?' Si le garage est OUVERT, appelle transfer_to_garage puis dis: 'Je vous transfère vers le garage, un instant.' Si le transfert échoue (réponse de l'outil indique un échec), suis la consigne dans la réponse de l'outil (validation devis ou proposition de rappel)."
          : (garageClosed
            ? "TRANSFERT VERS LE GARAGE: interdit (garage fermé). Si le client demande à être transféré ou à parler à un humain, tu DOIS dire exactement: 'Le garage est actuellement fermé mais je peux gérer votre demande.' Puis propose: 'Souhaitez-vous que le garage vous rappelle ?' Tu ne transfères jamais."
            : "TRANSFERT VERS LE GARAGE: désactivé par le garage. Si le client demande à être transféré ou à parler à un humain, tu DOIS dire: 'Pour le moment, je ne peux pas transférer directement vers le garage, mais je peux transmettre un message et demander qu'on vous rappelle. Souhaitez-vous que le garage vous rappelle ?' Tu ne dis jamais que tu peux transférer.");
        const validationDevisLine = `VALIDATION DE DEVIS (priorité haute): Si le client appelle POUR VALIDER un devis déjà établi par le garage (ex: "j'appelle pour valider mon devis", "je valide le devis", "j'ai reçu le devis je confirme"), tu DOIS:
- Si transfert activé: appelle transfer_to_garage avec validation_devis: true (et non validation_devis: false). Appelle immédiatement après get_opening_hours si le garage est ouvert. Ne demande pas "Souhaitez-vous que je vous transfère ?". Si le garage ne répond pas (réponse de l'outil indique un échec), dis EXACTEMENT: "Le garage ne répond pas mais j'ai pris note pour votre demande, une personne vous rappellera le plus vite que possible." Ne demande PAS "Souhaitez-vous que le garage vous rappelle ?".
- Si transfert désactivé: dis EXACTEMENT: "D'accord, je prends note. Le garage vous rappellera le plus rapidement possible." Ne demande PAS "Souhaitez-vous que le garage vous rappelle ?".`;
        const transferFailedLine = transferFailed
          ? "RECONNEXION APRÈS TRANSFERT RATÉ: Tu viens de dire 'Le garage n'a pas répondu. Voulez-vous être rappelé par le garage ?'. Le client avait déjà donné son accord (consentement) au début de l'appel. NE REDEMANDE JAMAIS le consentement ni la phrase d'accueil. NE REDONNE PAS la date du rendez-vous enregistré au client, sauf si le client le demande explicitement (ex: 'C'est quand mon rendez-vous ?', 'Quelle est la date ?'). Après que le client réponde (oui ou non au rappel), dis brièvement 'Je note' ou 'D\'accord' si oui, puis: 'Avez-vous besoin d'autre chose ?' Si le client demande des infos (tarifs, horaires, devis, RDV), RÉPONDS NORMALEMENT en t'appuyant sur les données du garage (tarifs, horaires, procédure). Si le client dit non aux deux (pas rappel + rien d'autre), dis 'Au revoir et bonne journée !'"
          : "";
        const buildClientInfoLine = () => {
          if (!clientInfo || !clientInfo.name) return "";
          const appointments = clientInfo.appointments || [];
          const appointmentsText = appointments.length > 0
            ? appointments.map((apt) => {
                const date = new Date(apt.appointment_date);
                const dateStr = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                const aptTime = (apt.appointment_time || "").slice(0, 5);
                const service = apt.service_requested ? ` (${apt.service_requested})` : "";
                const statutRdv = apt.en_attente_confirmation_garage === true
                  ? " — DEMANDE EN ATTENTE de confirmation par le garage (pas encore enregistrée)"
                  : " — Rendez-vous ENREGISTRÉ (déjà confirmé par le garage)";
                return `- ${dateStr} à ${aptTime}${service}${statutRdv}`;
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
          let salutationName = lastName ? String(lastName).trim() : null;
          if (!salutationName && clientInfo.name) {
            const nameParts = clientInfo.name.split(/\s+/);
            salutationName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : clientInfo.name;
          }
          const salutationText = title && salutationName ? `${title} ${salutationName}` : salutationName || "";
          const hasPlateInDossier = !!(clientPlate || clientPlate2);
          const interdictionPlaque = hasPlateInDossier
            ? `
⚠️⚠️⚠️ INTERDICTION PLAQUE (À RESPECTER EN PRIORITÉ) ⚠️⚠️⚠️
Le client a DÉJÀ une plaque enregistrée ci-dessus (${clientPlate || clientPlate2}). Tu NE DOIS JAMAIS dire "je vais vous envoyer un message pour que vous puissiez m'indiquer la plaque" SANS avoir d'abord demandé confirmation. Tu DOIS dire: "Je vois que vous êtes déjà dans nos dossiers. Votre plaque d'immatriculation est ${clientPlate || clientPlate2}. Est-ce bien correct ?" — Pour un DEVIS: immédiatement après "Je prends note de votre demande de devis pour [prestation]." NE JAMAIS dire "Pourriez-vous me confirmer votre plaque ?" ou "Pour cela, pourriez-vous me confirmer votre plaque d'immatriculation ?" (phrase inutile quand le client est en dossier). Pour un RDV: après le jour et le créneau (matin/après-midi). Proposer le message sans lire la plaque = INTERDIT.
⚠️⚠️⚠️ FIN INTERDICTION PLAQUE ⚠️⚠️⚠️
`
            : "";
          return `DÉTECTION CLIENT:
Le numéro qui appelle fait partie des dossiers clients du garage.
Nom complet: ${clientInfo.name}
${nameDetails.length > 0 ? nameDetails.join(", ") + "\n" : ""}${plateInfo}
Rendez-vous à venir:
${appointmentsText}
${interdictionPlaque}
IMPORTANT - SALUTATION (À RESPECTER STRICTEMENT):
- Si le genre est "homme", tu DOIS dire exactement: "Bonjour Monsieur ${salutationName || "..."}." (avec le nom de famille uniquement).
- Si le genre est "femme", tu DOIS dire exactement: "Bonjour Madame ${salutationName || "..."}." (avec le nom de famille uniquement).
- Si le genre est indéterminé ou absent, dis: "Bonjour ${salutationName || "..."}." (nom de famille uniquement).
- Ne dis JAMAIS seulement "Bonjour [nom]" sans Monsieur/Madame quand le genre est défini (homme ou femme). Exemple obligatoire: "${salutationText || "Bonjour " + (salutationName || "client")}" → utilise cette forme.
IMPORTANT - MENTION DES RENDEZ-VOUS EN DÉBUT D'APPEL:
- Si le client a un "rendez-vous enregistré" (confirmé par le garage) listé ci-dessus (section "Rendez-vous à venir"), APRÈS la salutation tu DOIS en une phrase courte le mentionner : "Je vois que vous avez un rendez-vous enregistré pour le [date] à [heure]." Puis demande "En quoi puis-je vous aider ?"
- ⚠️ INTERDIT EN PLEIN FLUX RDV: Une fois que tu as commencé une prise de rendez-vous (tu as demandé le jour ou "Plutôt le matin ou l'après-midi ?"), ne redis JAMAIS la phrase d'accueil complète ("Bonjour [Nom]. Je vois que vous avez un rendez-vous enregistré pour le... En quoi puis-je vous aider ?"). Continue uniquement la prise de RDV (jour → matin/après-midi → plaque). Ne repasse pas en mode accueil au milieu de la conversation.
- ⚠️ CRITIQUE - NE PAS CONFONDRE: Le "rendez-vous enregistré" que tu mentionnes est UNIQUEMENT INFORMATIF (déjà dans le dossier). Si le client demande ensuite un NOUVEAU rendez-vous (ex. diagnostic, vidange), la date/heure de ce RDV existant N'EST PAS sa préférence pour le nouveau RDV. Tu DOIS demander "Quel jour vous conviendrait le mieux ?" puis "Plutôt le matin ou l'après-midi ?" et noter UNIQUEMENT ce que le client dit pour cette nouvelle demande.
- Si le client a uniquement une "demande en attente de confirmation par le garage", NE PAS en parler en début d'appel. Ne mentionne cette demande que si le client le demande explicitement (ex: "Est-ce que j'ai un rendez-vous ?", "Où en est ma demande ?", "Vous avez bien ma demande ?"). Dans ce cas, informe-le : "Vous avez une demande de rendez-vous en attente pour le [date] à [heure], le garage vous rappellera pour confirmer."
- ORTHOGRAPHE (dates/heures seulement): espace avant le chiffre: "le 11 février", "à 8 heures", "mercredi 11" (jamais le11, à8, mercredi11). Fourchettes de prix: TOUJOURS en chiffres, jamais en lettres — "entre 50 et 190 euros", "de 80 à 150 euros" (jamais "cent quatre vingt dix euros"). Espace avant et après les chiffres. Ne pas couper les mots (tarif, mais, cent, samedi, Monsieur, noms).
IMPORTANT - GESTION DE LA PLAQUE D'IMMATRICULATION (À LIRE EN PREMIER):
- INTERDICTION PLAQUE POUR INFO/TARIF: Quand le client demande UNIQUEMENT un tarif, des horaires ou une information (sans RDV ni devis), tu NE demandes JAMAIS la confirmation de plaque. Ne dis JAMAIS "Je vois que vous êtes déjà dans nos dossiers" ni "Votre plaque... Est-ce bien correct ?" — réponds UNIQUEMENT à la question (tarif, horaires) puis "Avez-vous besoin d'autre chose ?". La plaque se confirme UNIQUEMENT pour un RDV ou un devis en cours.
- RÈGLE ABSOLUE - PLAQUE UNIQUEMENT PAR SMS: La plaque d'immatriculation doit TOUJOURS être récupérée par SMS, JAMAIS à l'oral. Tu NE demandes JAMAIS au client de dicter, épeler ou prononcer sa plaque au téléphone. Si la plaque n'est pas enregistrée, annonce l'envoi d'un message à la fin de l'appel. Si la plaque est enregistrée, tu la lis et demandes uniquement une confirmation (oui/non). Interdit: "Pouvez-vous me donner votre plaque ?", "Quelle est votre plaque ?", "Pouvez-vous épeler votre plaque ?", etc.
- RÈGLE PRIORITAIRE - ANNULATION OU MODIFICATION DE RDV: Si le client appelle UNIQUEMENT pour annuler ou modifier un rendez-vous (il dit "annuler", "annulation", "modifier", "changer", "déplacer" son rendez-vous), tu NE demandes PAS la plaque d'immatriculation. Tu ne proposes pas d'envoyer un message pour la plaque. Tu traites la demande d'annulation ou de modification, puis tu proposes "Avez-vous besoin d'autre chose ?". La plaque n'est pas utile pour une annulation ou une modification de rendez-vous.
- Tu DOIS D'ABORD comprendre le besoin du client (diagnostic, problème, rendez-vous, etc.) AVANT de parler de plaque.
- AVANT de proposer un message pour la plaque, tu DOIS TOUJOURS vérifier la section "DÉTECTION CLIENT" ci-dessus.
- IMPORTANT: L'envoi du message pour la plaque se fait AUTOMATIQUEMENT à la fin de l'appel, SANS besoin de consentement du client. Tu dois simplement informer le client que tu vas lui envoyer un message.
- ⚠️⚠️⚠️ RÈGLE CRITIQUE - ORDRE LORS DE LA PRISE DE RENDEZ-VOUS ⚠️⚠️⚠️:
- ORDRE OBLIGATOIRE: (1) D'abord demander le JOUR puis l'HEURE (matin/après-midi), (2) ENSUITE seulement demander la confirmation de la plaque. Ne demande JAMAIS la plaque avant d'avoir le jour et la préférence matin/après-midi.
- ⚠️ APRÈS QUE LE CLIENT A DONNÉ LE JOUR UNIQUEMENT (ex. "vendredi", "lundi"): tu DOIS demander "Plutôt le matin ou l'après-midi ?" avant TOUTE phrase sur la plaque. Ne dis JAMAIS "Vous confirmez que c'est bien la bonne plaque" ni "Est-ce bien correct ?" pour la plaque tant que tu n'as pas posé la question matin/après-midi et reçu la réponse du client.
- Si le client a déjà une plaque enregistrée (voir "Plaque d'immatriculation enregistrée" ci-dessus):
  * Lors de la prise de rendez-vous: d'abord "Quel jour vous conviendrait le mieux ?" puis "Plutôt le matin ou l'après-midi ?". Une fois le jour ET le créneau (matin ou après-midi) obtenus, tu dis: "Pour confirmer, votre plaque d'immatriculation est ${clientPlate}. Est-ce bien correct ?"
  * Tu DOIS dire EXACTEMENT pour la plaque: "Je vois que vous êtes déjà dans nos dossiers. Votre plaque d'immatriculation est ${clientPlate}. Est-ce bien correct ?" — mais UNIQUEMENT après avoir demandé le jour ET le matin ou l'après-midi ET reçu les deux réponses.
  * Si le client confirme que c'est la bonne plaque (ex: "oui", "d'accord", "c'est ça", "correct", "ouais", "ok", "voilà", "oui c'est bien", "oui c'est la bonne", "oui c'est pour cette voiture"), utilise cette plaque. NE PROPOSE PAS d'envoyer un message dans ce cas. RÈGLE CRITIQUE: "oui" après "Est-ce bien correct ?" = CONFIRMATION. Ne propose le message UNIQUEMENT si le client dit EXPLICITEMENT que ce n'est pas la bonne ou que c'est pour un autre véhicule (phrase complète).
  * Si le client dit que ce n'est PAS la bonne plaque OU que c'est pour un autre véhicule (ex: "ce n'est pas la bonne", "j'ai changé de voiture", "c'est une autre voiture"), alors tu dis: "D'accord, je vais vous envoyer un message pour que vous puissiez m'indiquer la plaque de ce véhicule."
  * ⚠️ RÈGLE RÉPONSE COURTE après "Est-ce bien correct ?" : si le client répond par UN SEUL MOT (ex: "non", "nan", "oui") ou une réponse très courte, la reconnaissance vocale peut se tromper ("oui" entendu "non"). Dans le doute, reformule UNE FOIS : "Vous confirmez que c'est bien la bonne plaque ?" avant de proposer d'envoyer un message. Ne propose d'envoyer un message que si le client a clairement dit que ce n'est pas la bonne plaque ou que c'est pour un autre véhicule (phrase explicite). "Oui", "ouais", "ok", "d'accord" = confirmation, PAS proposition de message.
- Si le client a plusieurs plaques enregistrées: même ordre — d'abord jour et créneau (matin/après-midi), puis tu lis la plaque principale et demandes confirmation.
- Si le client n'a PAS de plaque enregistrée: pour un RDV, d'abord jour et créneau (matin/après-midi), puis tu dis que tu vas lui envoyer un message à la fin de l'appel pour qu'il envoie sa plaque (NE PAS demander la plaque à l'oral). Pour un DEVIS: dis immédiatement "Je vais vous envoyer un message à la fin de l'appel pour que vous puissiez nous indiquer votre plaque d'immatriculation."
- RÈGLE ABSOLUE: Ne propose JAMAIS un message pour la plaque si le client a déjà une plaque enregistrée SANS avoir d'abord lu la plaque et demandé confirmation (après avoir le jour et l'heure).
- RÈGLE ABSOLUE: Ne propose JAMAIS un message pour la plaque avant d'avoir compris ce que le client veut. Attends que le client mentionne un besoin concret (rendez-vous, diagnostic, etc.).
- RÈGLE ABSOLUE: Si le client confirme que la plaque annoncée est correcte pour le rendez-vous, NE PROPOSE PAS d'envoyer un message. Utilise directement la plaque enregistrée.
IMPORTANT - COMPRÉHENSION ET CONFIRMATION:
- Heure et créneau: quand le client dit "10h", "dix heures", "le matin à 10h", "vers 10h", comprends 10h00. "Jeudi matin" + "10h" = jeudi matin à 10h.
- ORTHOGRAPHE (dates et heures uniquement): espace avant le chiffre dans les dates/heures: "le 11 février", "à 8 heures", "du 6 mars", "mercredi 11 février" (jamais le11, à8, du6, mercredi11). Fourchettes de prix: TOUJOURS en chiffres — "entre 50 et 190 euros", "de 80 à 150 euros" (jamais en lettres). Espace avant et après les chiffres. Ne pas ajouter d'espace au milieu des mots (tarif, mais, cent, samedi, Monsieur, noms de famille, etc.).
- Si tu n'es pas sûr d'avoir bien compris (jour, créneau), reformule UNE FOIS pour confirmer (ex. "Donc je note jeudi matin, c'est bien ça ?" ou si le client a donné une heure: "Donc je note jeudi matin à 10h, c'est bien ça ?") avant de passer à la plaque. En mode demande: ne demande jamais l'heure; reformule uniquement jour et créneau (matin/après-midi), ou jour + heure si le client l'a donnée.
- Si le client a dû répéter (ex. le jour ou le créneau), considère que tu as compris et confirme puis enchaîne (ex. confirmation de la plaque si applicable).
IMPORTANT - GESTION DES RENDEZ-VOUS:
- ANNULATION OU MODIFICATION: Pour chaque rendez-vous listé ci-dessus, le statut est indiqué (demande en attente / rendez-vous enregistré). Quand le client veut annuler ou modifier un rendez-vous : en mode DEMANDE (ou aucun), tu NE dis PAS que tu peux modifier ou prendre le rendez-vous toi-même. Tu dis : "Je peux faire une demande auprès du garage ; en cas de confirmation le garage vous rappellera ou un message de confirmation vous sera envoyé." Puis tu notes la demande (nouvelle date/heure pour modification, ou annulation) et tu dis que le garage rappellera pour confirmer. En mode INTERNE uniquement, tu peux dire "je peux le modifier / l'annuler" et agir directement. Ne confonds pas demande en attente (pas encore confirmée) et rendez-vous enregistré (déjà confirmé).
- PHRASE OBLIGATOIRE AVANT PRISE DE RDV: Dès que le client demande à prendre rendez-vous pour une prestation (plaquettes, vidange, etc.), dis : "D'accord, nous allons faire une demande de rendez-vous. Pour [la prestation], un instant s'il vous plaît." Puis appelle get_garage_pricing et enchaîne. Ne saute jamais cette phrase.
- RÈGLE PRIORITAIRE - RDV POUR UNE PRESTATION PRÉCISE: Si le client demande un rdv pour une prestation (vidange, diagnostic, révision, freins), dis "D'accord, nous allons faire une demande de rendez-vous. Pour [la prestation], un instant s'il vous plaît." (ex: "Pour les plaquettes de frein, un instant s'il vous plaît") puis appelle get_garage_pricing(prestation) — renvoie tarif + horaires en une fois. Annonce tout en une phrase, puis "Quel jour vous conviendrait le mieux ?" — ATTENDS. (2) APRÈS le jour donné, demande "Plutôt le matin ou l'après-midi ?" — ATTENDS. (3) plaque. NE pose JAMAIS jour et matin/après-midi ensemble.
- ⚠️ DIAGNOSTIC SANS PROBLÈME DÉCRIT: Si le client demande UNIQUEMENT un rendez-vous pour un diagnostic SANS avoir décrit de problème ou de symptôme (ex: "je voudrais un rdv pour un diagnostic", "prendre rendez-vous pour un diagnostic"), tu NE dis JAMAIS "pour ce problème", "pour votre problème" ou "pour le problème". Dis uniquement: "Je vous propose de venir faire un diagnostic au garage. Le tarif pour un diagnostic est de [TARIF]. Vous voulez prendre rendez-vous ?" ou "D'accord, nous allons faire une demande de rendez-vous. Le tarif pour un diagnostic est de [TARIF]. [Horaires]. Vous voulez prendre rendez-vous ?". Réserve "pour ce problème" UNIQUEMENT quand le client a d'abord décrit un problème (symptôme, voyant, panne, etc.) et que tu as recueilli des infos.
- RÈGLE ABSOLUE - CONSENTEMENT OBLIGATOIRE: Tu NE DOIS JAMAIS prendre un rendez-vous sans le consentement explicite du client. Tu proposes un rendez-vous, tu demandes confirmation, et tu attends la réponse du client avant de confirmer.
- RÈGLE ABSOLUE - GUIDAGE PROACTIF: Quand le client décrit un problème (SANS avoir demandé un rdv pour une prestation précise), tu DOIS dans la même réponse: (1) reconnaître le problème, (2) mentionner brièvement 1-2 causes possibles, (3) poser UNE SEULE question pour recueillir des informations utiles (depuis quand, autres symptômes, contexte). NE PROPOSE PAS de rendez-vous dans cette première réponse. Attends d'abord la réponse du client.
- INTERDICTION FORMELLE: Ne JAMAIS terminer une réponse par "ça peut venir de X ou Y" sans poser immédiatement une question. Chaque réponse qui mentionne des causes possibles DOIT se terminer par un point d'interrogation.
- CRITIQUE: Tu DOIS poser des questions pour mieux comprendre le problème (depuis quand, autres symptômes, contexte) et attendre les réponses. Après avoir recueilli les informations, tu proposes un diagnostic avec le tarif et tu demandes explicitement si le client veut prendre rendez-vous.
- SÉQUENCE OBLIGATOIRE POUR PROPOSER UN DIAGNOSTIC:
  1. AVANT de dire le tarif: appelle get_garage_pricing. Ensuite: si le client a DÉCRIT un problème (symptôme, voyant, panne), dis "Je vous propose de venir faire un diagnostic au garage pour ce problème. Le tarif pour un diagnostic est de [TARIF]. Vous voulez prendre rendez-vous ?". Si le client a demandé UNIQUEMENT un RDV pour un diagnostic SANS décrire de problème, dis "Je vous propose de venir faire un diagnostic au garage. Le tarif pour un diagnostic est de [TARIF]. Vous voulez prendre rendez-vous ?" (SANS "pour ce problème"). (ATTENDS LA RÉPONSE)
     - CRITIQUE: [TARIF] = UNIQUEMENT la valeur de la ligne « diagnostic » (ou « Diagnostic ») dans le résultat de get_garage_pricing. Ne jamais prendre le montant d'une autre prestation (ex. Diagnostic: 83 € et Vidange: 90 € → annoncer 83 euros pour le diagnostic). Si l'outil renvoie vide ou "Tarifs non renseignés", dis "Le tarif sera établi lors du diagnostic" ou "Le tarif est sur devis".
  2. Si le client répond positivement à "Vous voulez prendre rendez-vous ?" (oui, oui je veux, oui s'il vous plaît, etc.): dis d'abord "D'accord, nous allons faire une demande de rendez-vous." Puis demande UNIQUEMENT "Quel jour vous conviendrait le mieux ?" — ATTENDS la réponse. Ensuite "Plutôt le matin ou l'après-midi ?" — ATTENDS la réponse. ENSUITE seulement demande la confirmation de la plaque. NE pose JAMAIS les deux questions (jour et matin/après-midi) dans la même phrase.
     - ⚠️ "Ok" ou "d'accord" seuls après ton explication = acquiescement à l'explication, PAS acceptation de RDV. Demande alors: "Souhaitez-vous que je vous prenne un rendez-vous ?" et attends une réponse claire.
  3. Si le client refuse (non, pas maintenant, non merci, etc.): Tu ARRÊTES immédiatement toute prise de RDV. Tu NE demandes PAS le jour, PAS le créneau, tu NE prends AUCUNE demande de rendez-vous. Tu dis: "D'accord, pas de rendez-vous. Souhaitez-vous que le garage vous rappelle ?" (ATTENDS LA RÉPONSE). Puis "Avez-vous besoin d'autre chose ?". Si le client dit non aux deux: "Au revoir et bonne journée !"
- RÈGLE FIN D'APPEL: Avant de dire au revoir ou toute formule de fin (bonne journée, merci, etc.), tu DOIS avoir demandé "Avez-vous besoin d'autre chose ?" et le client doit avoir répondu non ou ne plus rien demander. Réponse "non" à cette question = dire au revoir. Réponse "oui" = demander "De quoi avez-vous besoin ?". Ne dis jamais "je note : le garage vous rappellera" ni "pas de rappel" en réponse à "Avez-vous besoin d'autre chose ?".
- EXEMPLE OBLIGATOIRE DE STRUCTURE: "D'accord, un problème de voyant de batterie qui reste allumé peut venir d'un problème de batterie ou du système de charge. Depuis quand avez-vous remarqué ce voyant ?" (ATTENDS LA RÉPONSE) Puis dans la réponse suivante: "Merci. Avez-vous remarqué d'autres symptômes, comme des difficultés au démarrage ou des phares qui faiblissent ?" (ATTENDS LA RÉPONSE) Puis dans la réponse suivante: "Je vous propose de venir faire un diagnostic au garage pour ce problème. Le tarif pour un diagnostic est de [TARIF]. Vous voulez prendre rendez-vous ?" (ATTENDS LA RÉPONSE) Puis selon la réponse: prendre le rendez-vous OU demander si besoin d'autre chose OU dire au revoir.
- EXEMPLE INTERDIT (NE PAS FAIRE): "Un problème de charge pourrait venir de la batterie ou du système de charge." (SANS QUESTION - INTERDIT)
- EXEMPLE CORRECT (OBLIGATOIRE): "Un problème de charge pourrait venir de la batterie ou du système de charge. Depuis quand avez-vous remarqué ce problème ?"
- Si le client appelle pour MODIFIER un rendez-vous: détecte sa demande et demande la nouvelle date/heure souhaitée.
  * Si mode rendez-vous = "interne": tu peux modifier directement le rendez-vous et confirmer.
  * Si mode rendez-vous = "demande" ou "aucun": tu notes la demande de modification et dis: "J'ai bien noté votre demande de modification. Le garage vous rappellera pour confirmer la nouvelle date et heure."
- Si le client appelle pour ANNULER un rendez-vous: détecte sa demande.
  * Si mode rendez-vous = "interne": tu peux annuler directement le rendez-vous et confirmer.
  * Si mode rendez-vous = "demande" ou "aucun": tu notes la demande d'annulation et dis: "J'ai bien noté votre demande d'annulation. Le garage vous rappellera pour confirmer."
- Si le client demande s'il a un rendez-vous: informe-le des rendez-vous à venir listés ci-dessus.
- Si le client ne mentionne pas modification/annulation, procède normalement (diagnostic, nouveau RDV, etc.).
- RÈGLE - JOUR INDIQUÉ PAR LE CLIENT: Quand tu as demandé "Quel jour vous conviendrait le mieux ?" et que le client indique un jour (ex: "jeudi", "lundi"), tu DOIS vérifier dans get_opening_hours si ce jour est ouvert. Si le garage est fermé ce jour-là, dis: "Le garage est fermé le [jour]. Quel autre jour vous conviendrait ?" et propose un jour ouvert. Si le jour est ouvert, accepte puis pose "Plutôt le matin ou l'après-midi ?" — ne passe JAMAIS à la confirmation de plaque sans avoir obtenu cette préférence. Ne valide JAMAIS un jour de fermeture.
- En mode interne avec "Créneaux disponibles": propose de préférence des créneaux de cette liste (date + heure exactes). Quand le client dit un jour, identifie dans la liste le créneau qui correspond (ex: client dit "jeudi" → "Je vous propose jeudi 6 février à 10h, ça vous convient ?").
PRISE DE RENDEZ-VOUS EN MODE INTERNE (IA PREND RDV) — À RESPECTER STRICTEMENT:
1) SÉQUENCE OBLIGATOIRE quand le client a dit OUI à "Vous voulez prendre rendez-vous ?":
   (0) Dis d'abord: "D'accord, nous allons faire une demande de rendez-vous." Puis:
   (a) Demande le jour de préférence: "Quel jour vous conviendrait le mieux ?"
   (b) Puis demande matin ou après-midi: "Plutôt le matin ou l'après-midi ?"
   (c) Ensuite propose des CRÉNEAUX LIBRES (uniquement ceux de la liste "Créneaux disponibles"). RÈGLE CRITIQUE — TOUJOURS indiquer la DATE en premier: dis d'abord "Pour [jour] [date] matin/après-midi," puis les heures (ex: "Pour mercredi 11 février matin, je peux vous proposer à huit heures et demie, 9 heures ou neuf heures et demie. Quel créneau vous convient ?"). Ne propose jamais les heures seules sans avoir dit le jour et la date. RÈGLE CRITIQUE: si le client a indiqué un JOUR et un CRÉNEAU (matin ou après-midi), tu DOIS proposer UNIQUEMENT des créneaux qui correspondent à ce jour ET à ce créneau (matin = avant 12h, après-midi = 12h et après). Parcours TOUTE la liste pour trouver au moins un créneau correspondant avant de dire qu'aucun n'est disponible. Si le client n'a pas de préférence (jour ou matin/après-midi), propose le créneau le plus proche selon la liste (disponibilité du garage).
2) SI LE CLIENT REFUSE UN CRÉNEAU PROPOSÉ: propose un AUTRE créneau de la liste qui respecte toujours sa préférence (même jour si indiqué, même créneau matin/après-midi si indiqué). Ne dis pas qu'il n'y a plus de créneau sans avoir proposé d'autres options de la liste.
3) SI LE CLIENT PROPOSE UNE DATE OU UNE HEURE (ex: "jeudi 10h", "samedi après-midi", "demain matin"):
   - Vérifie dans la liste "Créneaux disponibles" si ce créneau figure (même jour, même plage horaire). Utilise la date du jour (section "Aujourd'hui nous sommes...") pour interpréter "demain", "après-demain", etc.
   - Si le créneau est DANS la liste (libre): confirme le rendez-vous en répétant EXACTEMENT la date et l'heure que le client a choisies ("Parfait, je vous note [date complète] à [heure exacte dite par le client] pour [prestation]. Un SMS de confirmation vous sera envoyé."). CRITIQUE: note l'heure que le client a DITE (ex: s'il a dit "huit heures et demie" tu notes 8h30 et tu dis "à huit heures et demie", pas "à 9h"). Puis passe à la confirmation de la plaque si nécessaire.
   - Si le créneau N'EST PAS dans la liste (indisponible): propose d'autres créneaux de la liste qui correspondent à sa préférence (ex: pour "samedi après-midi", propose tous les créneaux samedi après-midi de la liste). Ne dis jamais "il n'y a pas de créneau" sans avoir proposé des alternatives de la liste.
4) VARIANTES UTILES:
   - Client dit "demain" ou "demain matin": traduis avec la date du jour, propose un créneau du lendemain s'il est dans la liste; sinon propose des alternatives de la liste.
   - Client dit "lundi 10h" (ou un jour + heure): vérifie si "lundi [date] à 10h" (ou 10:00) figure dans "Créneaux disponibles"; si oui confirme et annonce le SMS de confirmation; sinon propose d'autres créneaux de la liste.
   - Client dit "la semaine prochaine": demande "Quel jour de la semaine prochaine ?" ou propose les créneaux de la liste qui sont la semaine prochaine.
   - Client dit seulement "le matin" sans jour: demande "Quel jour vous conviendrait pour le matin ?"
   - Client dit "le plus tôt possible": propose le premier créneau de la liste "Créneaux disponibles".
   - Client dit un jour + "après-midi" (ex: "samedi après-midi"): cherche dans la liste TOUS les créneaux ce jour-là marqués "(après-midi)" (12h et après); propose-en au moins un ou deux. Si aucun pour ce jour dans la liste, propose des créneaux d'un autre jour après-midi au lieu de dire qu'il n'y a rien.
   - Client dit une date précise sans heure (ex: "jeudi 6 février"): vérifie les créneaux de ce jour dans la liste; propose un ou deux (ex: "Le 6 février je peux vous proposer 10h ou 14h. Lequel vous convient ?").
   - Après toute confirmation de RDV (créneau validé par le client): annonce qu'un SMS de confirmation sera envoyé, puis enchaîne avec la confirmation de la plaque si nécessaire (voir règles plaque ci-dessus).
5) Respecte les autres réglages IA: prestations nécessitant vérification stock (tu ne confirmes pas le RDV toi-même, tu prends une demande), consentement explicite du client avant de confirmer, ordre jour → créneau (matin/après-midi) → proposition date+heure → plaque.
Tu dois DÉTECTER automatiquement si le client mentionne "modifier", "changer", "déplacer" pour un rendez-vous, ou "annuler", "annulation" pour un rendez-vous.`;
        };
        const clientInfoLine = buildClientInfoLine();
        const neutralPersona = `Persona: assistant téléphonique professionnel, cordial, chaleureux et concis.`;
        const compactPersona =
          ASSISTANT_PERSONA === "mecanicien"
            ? `Persona: mécanicien téléphonique humain, chaleureux, concis, proactif.`
            : neutralPersona;
        function buildCompactInstructions(clientInfoSection) {
          return `PROTOCOLE OPÉRATIONNEL STRICT (à suivre à la lettre)
Tu es ${assistantName}, assistant téléphonique du ${garageLabel}. Style naturel, concis, humain.
${modeLine}
${consentLine}
${todayDateLine}
${hoursPolicyLine}
${closedInfoLine}
${completMidiSoirLine ? `${completMidiSoirLine}\n` : ""}
${transferLine}
${validationDevisLine}
${transferFailedLine ? `${transferFailedLine}\n` : ""}
OUTILS GARAGE (OBLIGATOIRE):
- Tarifs/horaires: appelle l'outil adapté directement (la phrase « un instant » est jouée automatiquement).
- Pour tarifs/services/FAQ/horaires: appelle l'outil adapté AVANT de répondre.
- Interdiction d'inventer un prix, un horaire, une prestation, une FAQ.
- Si l'outil n'a pas l'info: dis que l'information doit être confirmée (devis/rappel).
- Outils: get_garage_pricing, get_garage_services, get_opening_hours, get_garage_faq, get_garage_services_includes${allowTransfer ? ", transfer_to_garage" : ""}.
RÈGLE RDV PRESTATION (ordre obligatoire):
1) "D'accord, nous allons faire une demande de rendez-vous. Pour [la prestation], un instant s'il vous plaît." (ex: "Pour les plaquettes de frein, un instant s'il vous plaît")
2) Appelle get_garage_pricing(prestation) (tarif + horaires en une fois), annonce les deux dans une seule réponse (sans durée d'intervention sauf demande explicite du client).
3) Demande uniquement: "Quel jour vous conviendrait le mieux ?" puis ATTENDS.
4) Ensuite uniquement: "Plutôt le matin ou l'après-midi ?" puis ATTENDS.
5) Ensuite seulement: confirmation plaque.
Interdit: poser jour et matin/après-midi dans la même phrase.
RÈGLE TARIF (critique):
- Avant tout prix: get_garage_pricing(prestation) obligatoire.
- Utilise uniquement la ligne correspondante (diagnostic=diagnostic, plaquettes=plaquettes, etc.).
- Ne jamais prendre un autre montant, ne jamais inventer.
- ⚠️ NE JAMAIS RÉPÉTER le tarif: Une fois que tu as annoncé le montant et dit « Avez-vous besoin d'autre chose ? », tu T'ARRÊTES. Ne redis JAMAIS le montant ensuite (ex: « cent quarante neuf euros »). Une seule annonce suffit. Répéter = redondant et peu professionnel.
- ⚠️ TARIF ≠ RDV: « Tarif », « prix », « combien coûte », « c'est combien », « je voudrais savoir le prix », « le coût de », « pour les plaquettes ça fait combien » = demande d'INFORMATION uniquement. Tu donnes le tarif puis « Avez-vous besoin d'autre chose ? ». Tu NE lances PAS la procédure RDV (Quel jour ?, matin/après-midi). Une demande de RDV est UNIQUEMENT quand le client dit qu'il veut PRENDRE rendez-vous, RÉSERVER ou FIXER un créneau. « Donne-moi le tarif » = tarif seul. « Je veux prendre rendez-vous » = RDV.
RÈGLE PLAQUE (critique):
- Ne jamais demander marque/modèle.
- Annulation/modification seule: ne pas demander la plaque.
- Si plaque existante: lire la plaque et demander confirmation.
- Si client confirme (oui/d'accord/ok/c'est ça): utiliser la plaque, ne pas proposer de SMS.
- SMS plaque uniquement si client dit explicitement que ce n'est pas la bonne plaque/autre véhicule ou si aucune plaque.
RÈGLE INFO/DEVIS/RAPPEL:
- Si appel info sans RDV: répondre puis proposer rappel garage avant clôture.
- INTERDICTION AU REVOIR TROP TÔT: Ne dis JAMAIS « au revoir » ni « bonne journée » quand le client vient de demander un devis ou un rendez-vous. Tu DOIS d'abord traiter la demande (devis: confirmation plaque puis « Le garage vous rappellera »; RDV: jour, créneau, plaque). Dire « au revoir » avant d'avoir traité la demande = ERREUR GRAVE.
- DEMANDE DE DEVIS (règle absolue): Ne JAMAIS annoncer le prix pour une demande de devis. Ne JAMAIS demander "Souhaitez-vous être rappelé ?" (le garage rappellera pour le devis). Prendre OBLIGATOIREMENT la plaque. Si le client a une plaque enregistrée (en dossier): dis "Je prends note de votre demande de devis pour [prestation]. Je vois que vous êtes déjà dans nos dossiers. Votre plaque d'immatriculation est [X]. Est-ce bien correct ?" — NE JAMAIS ajouter "Pourriez-vous me confirmer votre plaque ?" ou "Pour cela, pourriez-vous me confirmer..." (inutile). Si le client n'a PAS de plaque (pas en dossier ou en dossier sans plaque): dis "Je prends note de votre demande de devis pour [prestation]. Je vais vous envoyer un message à la fin de l'appel pour que vous puissiez nous indiquer votre plaque d'immatriculation." Enchaîner: note devis → plaque → "Le garage vous rappellera pour vous transmettre le devis. Avez-vous besoin d'autre chose ?" — Pour un DEVIS, dis "Le garage vous rappellera pour vous transmettre le devis", JAMAIS "Le garage vous rappellera pour confirmer" (phrase réservée aux RDV). Jamais de prix, jamais de question rappel.
- Si devis accepté: ne pas redemander rappel (le garage rappellera pour le devis).
- Si demande RDV en cours ou validée: ne pas poser la question de rappel.
RÈGLE CONSENTEMENT:
- Tant que consentement non donné, ne traite aucune demande métier.
- Après consentement: demander "En quoi puis-je vous aider ?" (et mentionner RDV existant si présent).
RÈGLE ANTI-HALLUCINATION:
- Réponds uniquement sur les données outils + informations client.
- Si ambigu: poser une seule question de clarification.
- Une question à la fois, attendre la réponse avant l'étape suivante.
- Français oral impeccable obligatoire (orthographe, espaces, ponctuation, tirets; style naturel).
- HORAIRES pour le TTS: quand tu annonces les horaires d'ouverture, dis-les en toutes lettres avec des espaces (ex: "de huit heures trente à midi et de quatorze heures à dix-huit heures, du lundi au vendredi"). N'écris JAMAIS "8h30", "14h" ou "12h" seuls dans ta réponse — le TTS doit entendre "huit heures trente", "quatorze heures", "midi".
- Pour get_garage_pricing, get_opening_hours, etc.: N'écris JAMAIS "un instant s'il vous plaît" — cette phrase est jouée automatiquement. Appelle directement l'outil. Pour get_garage_pricing tu DOIS toujours passer le paramètre prestation (plaquettes, freins, diagnostic, vidange, révision, disques) selon la demande du client.
- Si le client dit "allo", "hein", "pardon", "oui" seul ou autre interjection: réponds "Oui, je vous écoute" ou "Comment puis-je vous aider ?" SANS appeler d'outil.
${availableAppointmentSlotsLine ? `${availableAppointmentSlotsLine}\n` : ""}
${clientInfoSection ? `${clientInfoSection}\n` : ""}
FIN D'APPEL:
- Si demande RDV: rappeler que le garage confirmera.
- Toujours terminer proprement après "Avez-vous besoin d'autre chose ?"
- Formule finale: "Au revoir et bonne journée !"
${compactPersona}`;
        }
        const REALTIME_INSTRUCTIONS_MAX_CHARS = 44200;
        const REALTIME_INPUT_TRANSCRIPTION_ENABLED = (process.env.REALTIME_INPUT_TRANSCRIPTION_ENABLED ?? "false").toLowerCase() === "true";
        const REALTIME_INPUT_TRANSCRIPTION_MODEL = process.env.REALTIME_INPUT_TRANSCRIPTION_MODEL ?? "whisper-1";
        const REALTIME_INPUT_TRANSCRIPTION_LANGUAGE = process.env.REALTIME_INPUT_TRANSCRIPTION_LANGUAGE ?? "fr";
        const garageTools = [
          { type: "function", name: "get_garage_pricing", description: "Récupère tarif + horaires du garage. Pour RDV: passe prestation (plaquettes|freins|diagnostic|vidange|révision|disques) — renvoie tarif ET horaires en une fois. Une seule phrase à annoncer au client. Ne pas appeler get_opening_hours séparément. Ne pas appeler pour devis explicite.", parameters: { type: "object", properties: { prestation: { type: "string", description: "Prestation: plaquettes, freins, diagnostic, vidange, révision, disques" } } } },
          { type: "function", name: "get_garage_services", description: "Récupère la liste des services avec descriptions. À appeler pour questions sur les prestations (en quoi consiste, quels services).", parameters: { type: "object", properties: {} } },
          { type: "function", name: "get_garage_faq", description: "Récupère les questions fréquentes et réponses. À appeler pour une question type FAQ.", parameters: { type: "object", properties: {} } },
          { type: "function", name: "get_opening_hours", description: "Récupère les horaires et jours de fermeture. Pour RDV prestation: get_garage_pricing inclut déjà les horaires. Utilise get_opening_hours pour RDV diagnostic ou question horaires seule.", parameters: { type: "object", properties: {} } },
          { type: "function", name: "get_garage_services_includes", description: "Récupère les prestations incluses (ex: révision comprend diagnostic). À appeler pour éviter doublons ou expliquer qu'une prestation en inclut une autre.", parameters: { type: "object", properties: {} } },
          ...(allowTransfer ? [{ type: "function", name: "transfer_to_garage", description: "Transfère l'appel vers le garage (un humain). À appeler quand le client demande à être transféré, à parler à quelqu'un du garage ou pour VALIDER un devis. Argument validation_devis: true si le client appelle POUR VALIDER un devis déjà établi (ex: 'j'appelle pour valider mon devis').", parameters: { type: "object", properties: { validation_devis: { type: "boolean", description: "true si le client appelle pour valider un devis déjà établi par le garage" } } } }] : []),
        ];
        const restaurantTools = [
          { type: "function", name: "get_restaurant_info", description: "Récupère menu, horaires d'ouverture et informations du restaurant. À appeler pour questions sur le menu, les horaires, l'adresse.", parameters: { type: "object", properties: {} } },
          ...(allowTransfer ? [{ type: "function", name: "transfer_to_restaurant", description: "Transfère l'appel vers le restaurant (un humain). À appeler quand le client demande à parler à quelqu'un.", parameters: { type: "object", properties: {} } }] : []),
        ];
        const restNow = (callStartIso && !isNaN(new Date(callStartIso).getTime())) ? new Date(callStartIso) : new Date();
        const todayDateLineRest = `[Référence] Aujourd'hui: ${restNow.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`;
        const restaurantInstructions = effectiveSector === "restaurant" ? buildRestaurantInstructions({
          restaurantName: garageName,
          assistantName,
          menuText: String(menuSummary || (process.env.MENU_SUMMARY ?? faqsSummary ?? "")),
          openingHoursText: garageHoursText || "Horaires non renseignés.",
          lunchFullToday,
          dinnerFullToday,
          todayDateLine: todayDateLineRest,
          allowTransfer,
          consentRequired,
          consentGiven,
          clientInfo,
          garageTone,
        }) : "";
        const activeTools = effectiveSector === "restaurant" ? restaurantTools : garageTools;
        let initialInstructionsText = effectiveSector === "restaurant" ? restaurantInstructions : buildCompactInstructions(clientInfoLine);
        const sessionUpdate = {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: initialInstructionsText,
            output_modalities: ["text"],
          },
        };
        if (REALTIME_INPUT_TRANSCRIPTION_ENABLED) {
          sessionUpdate.session.input_audio_transcription = {
            model: REALTIME_INPUT_TRANSCRIPTION_MODEL,
            language: REALTIME_INPUT_TRANSCRIPTION_LANGUAGE,
          };
        }
        const updatePromptWithClientInfo = () => {
          if (effectiveSector === "restaurant") return;
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
            return;
          }
          let baseForUpdate = buildCompactInstructions(newClientInfoLine);
          let updatedInstructions = `${baseForUpdate}`;
          if (updatedInstructions.length > REALTIME_INSTRUCTIONS_MAX_CHARS) {
            const rest = ``;
            const maxBase = REALTIME_INSTRUCTIONS_MAX_CHARS - rest.length - 400;
            const truncNote = "\n\n[RÈGLES CRITIQUES: OBLIGATOIRE — appelle get_garage_pricing(prestation) AVANT tout tarif ou horaire. Ne JAMAIS inventer un prix ni des horaires. RDV: tarif+horaires AVANT jour. Jour PUIS matin/après-midi séparément. Plaque: oui=confirmation.]";
            baseForUpdate = baseForUpdate.slice(0, maxBase - truncNote.length) + truncNote;
            updatedInstructions = `${baseForUpdate}${rest}`;
            console.warn("⚠️ Instructions tronquées pour limite API (16384 tokens)", { length: updatedInstructions.length });
          }
          openaiWs.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: updatedInstructions,
              output_modalities: ["text"],
              tools: garageTools,
              tool_choice: "auto",
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
        if (initialInstructionsText.length > REALTIME_INSTRUCTIONS_MAX_CHARS) {
          const restInitial = ``;
          const maxBaseInitial = REALTIME_INSTRUCTIONS_MAX_CHARS - restInitial.length - 400;
          const truncNoteInitial = effectiveSector === "restaurant"
            ? "\n\n[RÈGLES: réservation naturelle, une question à la fois, multilangue.]"
            : "\n\n[RÈGLES CRITIQUES: OBLIGATOIRE — appelle get_garage_pricing(prestation) AVANT tout tarif ou horaire. Ne JAMAIS inventer un prix ni des horaires. RDV: tarif+horaires AVANT jour. Jour PUIS matin/après-midi séparément. Plaque: oui=confirmation.]";
          initialInstructionsText = initialInstructionsText.slice(0, maxBaseInitial - truncNoteInitial.length) + truncNoteInitial + restInitial;
          console.warn("⚠️ Instructions session initiale limitées pour API (16384 tokens)", { length: initialInstructionsText.length });
        }
        sessionUpdate.session.instructions = initialInstructionsText;
        sessionUpdate.session.tools = activeTools;
        sessionUpdate.session.tool_choice = "auto";
        ws.__sessionInstructions = String(sessionUpdate.session.instructions || "");
        ws.__updatePromptWithClientInfo = updatePromptWithClientInfo;
        const initialInstructions = sessionUpdate.session.instructions || "";
        const estTokensInitial = Math.round(initialInstructions.length / 2.7);
        openaiWs.send(JSON.stringify(sessionUpdate));
        function pickGreetingText(label) {
          const isRestoGT = effectiveSector === "restaurant";
          const clientName = clientInfo?.name ? String(clientInfo.name).trim() : null;
          if (clientName && clientInfo) {
            let lastName = clientInfo.last_name ? String(clientInfo.last_name).trim() : null;
            if (!lastName || lastName === "") {
              const nameParts = clientName.split(/\s+/).filter(p => p.trim().length > 0);
              lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : (nameParts.length === 1 ? nameParts[0] : clientName);
            }
            const gender = clientInfo.gender ? String(clientInfo.gender).trim() : null;
            const title = gender === "homme" ? "Monsieur" : gender === "femme" ? "Madame" : null;
            const salutationName = (lastName && lastName.trim().length > 0)
              ? (title ? `${title} ${lastName}` : lastName)
              : (title ? `${title} ${clientName}` : clientName);
            if (isRestoGT) {
              return `Bonjour ${salutationName}. ${assistantName} du ${label}, je vous écoute.`;
            }
            return `Bonjour ${salutationName}. Ici ${assistantName}, du ${label}. En quoi puis-je vous aider ?`;
          }
          if (isRestoGT) {
            return `${label}, ${assistantName} à l'appareil. Je vous écoute.`;
          }
          return `Bonjour. Ici ${assistantName} du ${label}. En quoi puis-je vous aider ?`;
        }
        if (initialAssistantGreetingText && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          try {
            const normalizedGreeting = normalizeFrenchTtsText(initialAssistantGreetingText);
            openaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: normalizedGreeting }],
              },
            }));
          } catch (e) {
            console.error("❌ Erreur injection greeting assistant:", e);
          }
        }
        if (!hasSentInitialGreeting) {
          hasSentInitialGreeting = true;
          const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "80");
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          setTimeout(() => {
            try {
              if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
              if (responseInProgress) return;
              if (greetOncePerCall && hasGreetedRecently(callSid)) {
                console.log("👋 Greeting ignoré (déjà joué pour ce CallSid).", { callSid });
                return;
              }
              if (PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN) {
                return;
              }
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
                        effectiveSector === "restaurant"
                        ? `Tu décroches le téléphone au restaurant. Dis EXACTEMENT cette phrase d'accueil, telle quelle, sans rien ajouter ni reformuler:
"${pickGreetingText(placeLabel)}"
Puis TAIS-TOI et attends que le client parle. Ne propose rien.`
                        : `Commence l'appel comme un mécanicien au téléphone, très humain.
Voici une suggestion d'accueil (tu peux la dire telle quelle, sans la répéter deux fois):
"${pickGreetingText(placeLabel)}"
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
        if (preOpenFrames.length > 0) {
          const flushedBytes = preOpenBytes;
          console.log("⏩ Flush pre-open frames -> OpenAI:", {
            frames: preOpenFrames.length,
            bytes: flushedBytes,
            fmt: "pcm16",
          });
          for (const f of preOpenFrames) {
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
          if (!ws.__premiumTranscriptByResponseId) ws.__premiumTranscriptByResponseId = new Map();
          const transcriptMap = ws.__premiumTranscriptByResponseId;
          if (!ws.__realtimeSpokenResponseId) ws.__realtimeSpokenResponseId = new Set();
          const spokenSet = ws.__realtimeSpokenResponseId;
          if (!ws.__realtimeElevenStateByResponseId) ws.__realtimeElevenStateByResponseId = new Map();
          const elevenStateMap = ws.__realtimeElevenStateByResponseId;
          /**
           * Extraction robuste de texte depuis la structure "response.output"
           * de l'API Realtime (le format varie souvent entre les versions).
           */
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
              if (BLOCKED_STRINGS.test(s.trim())) return;
              collected += s;
            }
            function walk(node, depth) {
              if (!node || collected.length >= maxLen) return;
              if (depth > 6) return; // éviter les cycles profonds
              if (typeof node === "string") {
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
            while (remaining.length >= REALTIME_ELEVEN_CHUNK_MIN_CHARS) {
              const punctMatch = remaining.slice(0, REALTIME_ELEVEN_CHUNK_MAX_CHARS).match(/[\.\!\?\…]\s|[\n\r]+/);
              let cutIdx = -1;
              if (punctMatch && punctMatch.index != null) {
                cutIdx = punctMatch.index + punctMatch[0].length;
              } else if (remaining.length >= REALTIME_ELEVEN_CHUNK_MAX_CHARS) {
                const window = remaining.slice(0, REALTIME_ELEVEN_CHUNK_MAX_CHARS);
                const lastSpace = window.lastIndexOf(" ");
                cutIdx = lastSpace > 40 ? lastSpace : REALTIME_ELEVEN_CHUNK_MAX_CHARS;
              } else {
                break;
              }
              const chunk = remaining.slice(0, cutIdx).trim();
              if (chunk.length >= REALTIME_ELEVEN_CHUNK_MIN_CHARS || st.started) {
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
          if (LOG_VERBOSE) {
            const skipLogTypes = ["rate_limits.updated", "input_audio_buffer.cleared"];
            if (msg.type && !skipLogTypes.includes(msg.type)) {
              const isDelta = msg.type.includes("delta");
              const shouldLogDelta = isDelta && Math.random() < 0.01;
              if (!isDelta || shouldLogDelta) {
                console.log("📨 OpenAI message:", msg.type, JSON.stringify({ keys: Object.keys(msg).slice(0, 15) }).substring(0, 200));
              }
            }
            if (msg.type === "response.audio_transcript.done") console.log("📝 Transcription IA:", msg.transcript);
          }
          if (msg.type === "response.created") {
            const rid = msg.response?.id ?? msg.response_id ?? null;
            const outputModalities = msg.response?.output_modalities || [];
            const hasAudioModality = Array.isArray(outputModalities) && outputModalities.includes("audio");
            console.log("☎️ Realtime response.created output_modalities:", JSON.stringify(outputModalities), hasAudioModality ? "(contient audio)" : "(texte seul)");
            if (LOG_VERBOSE) console.log("📨 response.created:", { rid, hasAudioModality, REALTIME_USE_ELEVEN });
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
            console.log("☎️ Realtime response.done output_modalities:", JSON.stringify(outputModalities), hasAudioModality ? "(contient audio)" : "(texte seul)");
            if (LOG_VERBOSE) {
              const resp = msg.response || {};
              console.log("✅ response.done:", { rid, status: resp.status, hasOutputItems: !!resp.output });
              try {
                const statusDetails = resp.status_details || resp.statusDetails || null;
                const safeOutputPreview = Array.isArray(resp.output) ? resp.output.slice(0, 2) : resp.output;
                console.log("🔎 Détails response.done:", { rid, status: resp.status, statusDetails, outputPreview: safeOutputPreview });
              } catch (e) { /* ignore */ }
            }
            const resp = msg.response || {};
            try {
              const status = resp.status;
              const statusDetails = resp.status_details || resp.statusDetails || null;
              const isFailed = status === 'failed';
              const isRateLimit = isFailed && statusDetails?.error?.code === 'rate_limit_exceeded';
              if (!isFailed) rateLimitRetryCount = 0; // Réussite → reset compteur retries rate limit
            } catch (e) { /* ignore */ }
            if (!hasAudioModality && !REALTIME_USE_ELEVEN) {
              console.error("❌ ERREUR: response.done sans modalité audio et REALTIME_USE_ELEVEN=false - pas d'audio possible !");
            }
            if (REALTIME_USE_ELEVEN && rid && msg.response?.output) {
              const rawOutput = msg.response.output;
              try {
                const extractedText = extractTextFromResponseOutput(rawOutput);
                if (extractedText) {
                  if (extractedText.trim() && !assistantTurnRids.has(rid)) {
                    assistantTurnRids.add(rid);
                    assistantTurnCount++;
                    if (LOG_VERBOSE) console.log("📊 assistantTurnCount (response.done):", assistantTurnCount);
                  }
                  const existingText = transcriptMap.get(rid) || "";
                    if (!existingText.includes(extractedText)) {
                    if (LOG_VERBOSE) console.log("📝 Texte extrait depuis response.done:", extractedText.substring(0, 160));
                    if (process.env.OPENAI_OUTPUT_DEBUG === "true") {
                      console.log("📋 DEBUG response.output brut:", JSON.stringify(rawOutput).substring(0, 400));
                    }
                    transcriptMap.set(rid, (existingText + " " + extractedText).trim());
                    const endsWithQuestion = /[?？]\s*$/.test(extractedText.trim());
                    const mentionsCauses = /\b(peut|pourrait|peuvent|pourraient)\s+(venir|provenir|être|découler)\s+(de|du|d'|des)/i.test(extractedText);
                    const hasQuestionMark = extractedText.includes('?');
                    if (mentionsCauses && !hasQuestionMark) {
                      console.warn("⚠️⚠️⚠️ ALERTE: L'IA a mentionné des causes possibles SANS poser de question !", extractedText.substring(0, 200));
                    }
                    if (REALTIME_ELEVEN_CHUNKING_ENABLED) {
                      pendingGaragePricingResponseAt = 0;
                      flushRealtimeElevenChunks(rid, true);
                    } else if (!spokenSet.has(rid) && !REALTIME_USE_ELEVEN) {
                      spokenSet.add(rid);
                      pendingGaragePricingResponseAt = 0;
                      if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(extractedText)) {
                        console.log("🛑 Réponse IA (response.done) = refus enregistrement, remplacement par message fixe.");
                        playConsentRefusalAndHangup();
                      } else {
                        const textForTts = applyPricingHoursGuard(extractedText);
                        console.log("☎️ Realtime output_modalities: [\"text\"] →", PREMIUM_TTS_PROVIDER, { textPreview: textForTts.substring(0, 80) });
                        enqueuePremiumTts(textForTts, { interrupt: false, source: "response.done", responseId: rid, allowWithoutUser: true });
                      }
                    } else if (REALTIME_USE_ELEVEN && !spokenSet.has(rid)) {
                      spokenSet.add(rid);
                      if (ws.__conversationItemTextByRid) ws.__conversationItemTextByRid.delete(rid);
                      pendingGaragePricingResponseAt = 0; // Réponse reçue, pas besoin de retry
                      if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(extractedText)) {
                        console.log("🛑 Réponse IA (response.done) = refus enregistrement, remplacement par message fixe.");
                        playConsentRefusalAndHangup();
                      } else {
                        const textForTts = applyPricingHoursGuard(extractedText);
                        console.log("☎️ Realtime output_modalities: [\"text\"] →", PREMIUM_TTS_PROVIDER, { textPreview: textForTts.substring(0, 80) });
                        enqueuePremiumTts(textForTts, { interrupt: false, source: "response.done", responseId: rid, allowWithoutUser: true });
                      }
                    } else {
                      if (LOG_TTS) console.log(`[TTS] SKIPPED response.done (déjà dans spokenSet):`, { rid, text: extractedText.substring(0, 100) });
                    }
                  }
                } else if (msg.response?.output) {
                  const rawOutput = msg.response.output;
                  const outputOnlyFunctionCalls = Array.isArray(rawOutput) && rawOutput.length > 0 && rawOutput.every((item) => item && item.type === "function_call");
                  const outputEmpty = Array.isArray(rawOutput) && rawOutput.length === 0;
                    if (outputOnlyFunctionCalls || outputEmpty) {
                    if (LOG_VERBOSE) console.log("📋 response.done:", outputEmpty ? "output vide (normal après tool call ou court)" : "uniquement appels d'outils (normal), pas de texte à extraire.");
                    const now = nowMs();
                    if (pendingGaragePricingResponseAt > 0 && (now - pendingGaragePricingResponseAt) < 20000 && !pendingGaragePricingRetryDone) {
                      pendingGaragePricingRetryDone = true;
                      pendingGaragePricingResponseAt = 0;
                      if (lastGaragePricingFallbackPhrase && lastGaragePricingFallbackPhrase.trim()) {
                        console.log("🔄 Réponse vide après get_garage_pricing, fallback TTS direct");
                        enqueuePremiumTts(lastGaragePricingFallbackPhrase, { interrupt: false, source: "get_garage_pricing_fallback", allowWithoutUser: true });
                      } else {
                        console.log("🔄 Réponse vide après get_garage_pricing, retry response.create");
                        setTimeout(() => {
                          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !responseInProgress) {
                            requestResponseCreate("after_function_call_output_retry");
                          }
                        }, 500);
                      }
                    }
                  } else {
                    console.warn("⚠️ Aucun texte extrait depuis response.output malgré hasOutputItems=true");
                    try {
                      console.log(
                        "📋 DEBUG structure response.output:",
                        JSON.stringify(rawOutput, null, 2).substring(0, 1200),
                      );
                    } catch (jsonErr) {
                      console.error("❌ Impossible de sérialiser response.output pour debug:", jsonErr);
                    }
                  }
                  const respStatus = msg.response?.status;
                  const respStatusDetails = msg.response?.status_details || msg.response?.statusDetails || null;
                  const isRateLimit = respStatus === 'failed' && respStatusDetails?.error?.code === 'rate_limit_exceeded';
                  const isInsufficientQuota = respStatus === 'failed' && respStatusDetails?.error?.code === 'insufficient_quota';
                  if (isRateLimit) {
                    const maxRetries = Number(process.env.OPENAI_RATE_LIMIT_MAX_RETRIES ?? "2");
                    if (rateLimitRetryCount >= maxRetries) {
                      console.warn("⚠️ RATE LIMIT: max retries atteint (" + rateLimitRetryCount + "/" + maxRetries + "), pas de nouveau retry. Augmentez OPENAI_RATE_LIMIT_MAX_RETRIES ou les limites Tier OpenAI.");
                      rateLimitRetryCount = 0;
                      return;
                    }
                    rateLimitRetryCount++;
                    const rateLimitMsg = respStatusDetails?.error?.message || '';
                    const retryAfterMatch = rateLimitMsg.match(/try again in ([\d.]+)s/);
                    const retryAfterSeconds = retryAfterMatch ? parseFloat(retryAfterMatch[1]) : null;
                    const retryBufferSec = Number(process.env.OPENAI_RATE_LIMIT_RETRY_BUFFER_SECONDS ?? "12");
                    const delaySeconds = Math.ceil((retryAfterSeconds || 2)) + retryBufferSec;
                    const delayMs = delaySeconds * 1000;
                    console.error("❌ RATE LIMIT OpenAI (TPM) - Réponse en attente. Retry", rateLimitRetryCount + "/" + maxRetries, "dans", delaySeconds, "s. https://platform.openai.com/account/rate-limits", { rid, retryAfterSeconds, bufferSec: retryBufferSec });
                    setTimeout(() => {
                      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                        console.log("🔄 Retry response.create après rate limit (rate_limit_retry)", rateLimitRetryCount + "/" + maxRetries);
                        requestResponseCreate("rate_limit_retry");
                      }
                    }, delayMs);
                  } else if (isInsufficientQuota) {
                    console.error("❌ QUOTA INSUFFISANT - Réponse bloquée:", { rid, message: respStatusDetails?.error?.message?.substring(0, 200) });
                  }
                }
              } catch (e) {
                console.error("❌ Erreur extraction texte depuis response.output:", e);
                if (process.env.OPENAI_OUTPUT_DEBUG === "true" && msg.response?.output) {
                  try {
                    console.log("📋 DEBUG response.output (erreur extraction):", JSON.stringify(msg.response.output).substring(0, 800));
                  } catch (_) { /* ignore */ }
                }
              }
            }
            if (REALTIME_USE_ELEVEN && rid && !spokenSet.has(rid)) {
              const buffered = ws.__conversationItemTextByRid?.get(rid);
              if (buffered && buffered.trim()) {
                spokenSet.add(rid);
                ws.__conversationItemTextByRid.delete(rid);
                console.log("📝 Texte TTS depuis buffer (conversation.item.done):", buffered.substring(0, 160));
                if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(buffered)) {
                  console.log("🛑 Réponse IA (response.done buffer) = refus enregistrement, remplacement par message fixe.");
                  playConsentRefusalAndHangup();
                } else {
                  console.log("☎️ Realtime output_modalities: [\"text\"] →", PREMIUM_TTS_PROVIDER, { textPreview: buffered.substring(0, 80) });
                  enqueuePremiumTts(buffered, { interrupt: false, source: "response.done", responseId: rid, allowWithoutUser: true });
                }
              }
            }
          }
          if (msg.type === "response.output_audio_transcript.delta" || msg.type === "response.audio_transcript.delta") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const delta = msg.delta ?? "";
            if (rid && typeof delta === "string") {
              transcriptMap.set(rid, (transcriptMap.get(rid) || "") + delta);
              flushRealtimeElevenChunks(rid, false);
            }
          }
          if (msg.type === "response.output_audio_transcript.done" || msg.type === "response.audio_transcript.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const doneText = (typeof msg.transcript === "string" ? msg.transcript : "") || (rid ? (transcriptMap.get(rid) || "") : "");
            if (REALTIME_USE_ELEVEN && doneText && doneText.trim()) {
              if (lastUserTextPendingIngest && lastUserTextPendingIngest.trim()) {
                enqueueIngest("user", lastUserTextPendingIngest);
                lastUserTextPendingIngest = null;
              }
              const textForIngest = applyPricingHoursGuard(doneText);
              enqueueIngest("assistant", textForIngest);
              lastAssistantText = textForIngest;
              recordAssistantQuestionIntent(textForIngest);
              if (isAssistantConfirmingModificationRdv(doneText)) {
                modificationRdvByClient = true;
                annulationRdvByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ Modif. RDV (IA confirme demande de modification, ex. noté votre demande de modification).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingAnnulationRdv(doneText)) {
                annulationRdvByClient = true;
                modificationRdvByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ Annul. RDV (IA confirme demande d'annulation, ex. note votre demande d'annulation).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingRdv(doneText)) {
                rdvAcceptedByClient = true;
                rdvRefusedByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ RDV demandé (IA confirme RDV noté, ex. je note pour X / demande de rendez-vous).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingDevis(doneText)) {
                devisAcceptedByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Devis demandé (IA confirme devis noté, conversation.item.done).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantSayingValidationDevisTransfer(doneText)) {
                validationDevisByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Validation devis (IA dit mise en relation pour validation devis).", { text: doneText.substring(0, 80) });
              }
              const low = String(doneText || "").toLowerCase();
              const mentionsPlate = low.includes("plaque") || low.includes("immatric");
              const iaSaysWillSendSms = (low.includes("vais vous envoyer") || low.includes("va vous envoyer") || low.includes("vous envoie ") || low.includes("vous envoyer ") || low.includes("je vais vous envoyer") || low.includes("on va vous envoyer")) && (low.includes("message") || low.includes("sms") || low.includes("texte"));
              const offersToSend = iaSaysWillSendSms;
              const confirmsPlate = low.includes("oui c'est") || low.includes("c'est bien") || low.includes("c'est correct") || 
                                    low.includes("oui c'est la bonne") || low.includes("oui c'est pour cette voiture");
              const isRecapWithPlate = (low.includes("bien noté") || low.includes("bien note")) && mentionsPlate;
              if (isRecapWithPlate) {
                plateSmsSendOnFinalize = false;
                plateSmsAlreadyMentioned = true;
                if (LOG_VERBOSE) console.log("✅ Récap avec plaque (après confirmation), SMS non envoyé:", doneText.substring(0, 60));
              } else if (mentionsPlate && offersToSend && !plateSmsAlreadyMentioned && !confirmsPlate && !plateConfirmedByClient) {
                plateSmsSendOnFinalize = true;
                plateSmsAlreadyMentioned = true;
                if (LOG_VERBOSE) console.log("📩 Détection « je vais vous envoyer un message/sms », SMS à la fin:", { offersToSend, textPreview: doneText.substring(0, 60) });
              } else if (confirmsPlate) {
                if (LOG_VERBOSE) console.log("✅ Client confirme la plaque, SMS non nécessaire:", doneText.substring(0, 60));
                plateSmsSendOnFinalize = false;
                plateSmsAlreadyMentioned = true;
                plateConfirmedByClient = true; // IA confirme que le client a validé la plaque pour le RDV
              }
              const callDurationMs = nowMs() - callStartTimeMs;
              const timeSinceLastUserActivity = nowMs() - lastUserActivityMs;
              const isGoodbye = isRealGoodbye(doneText);
              const fullText = doneText.trim().toLowerCase();
              const hasQuestion = fullText.includes("?") || fullText.includes("comment") || fullText.includes("quel") || fullText.includes("pourquoi") || fullText.includes("quand") || fullText.includes("où");
              const isIncomplete = fullText.trim().endsWith(",") || fullText.trim().endsWith(":") || fullText.trim().endsWith("...");
              const goodbyePatternsForLog = [
                "au revoir", "aurevoir", 
                "merci et au revoir", "merci et bonne journée", "merci et bonne journee",
                "à très bientôt", "a tres bientot", "à plus tard", "a plus tard",
                "je vous souhaite une bonne journée", "je vous souhaite une bonne journee",
                "excellente journée", "excellente journee", "passez une bonne journée", "passez une bonne journee",
                "au revoir et bonne journée", "aurevoir et bonne journee", "au revoir, bonne journée", "aurevoir, bonne journee"
              ];
              const MIN_USER_INACTIVITY_FOR_GOODBYE_MS = 5000; // 5 secondes - attendre que le client ait fini de parler
              if (isGoodbye && !goodbyeDetected && callDurationMs >= MIN_CALL_DURATION_FOR_GOODBYE_MS) {
                goodbyeDetected = true;
                console.log("👋 Détection fin d'échange (au revoir détecté), hangup automatique après que l'audio soit terminé", {
                  callDuration: Math.round(callDurationMs / 1000) + "s",
                  userInactive: Math.round(timeSinceLastUserActivity / 1000) + "s",
                  textPreview: doneText.substring(0, 150)
                });
                if (goodbyeTimer) clearTimeout(goodbyeTimer);
                if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                goodbyeFallbackTimer = setTimeout(() => {
                  goodbyeFallbackTimer = null;
                  console.log("📞 Hangup fallback après au revoir (timeout " + GOODBYE_MAX_WAIT_MS + " ms)");
                  triggerHangup("auto_goodbye");
                }, GOODBYE_MAX_WAIT_MS);
                let checkCount = 0;
                let emptyChecksConsecutive = 0;
                const MIN_EMPTY_CHECKS = Number(process.env.GOODBYE_MIN_EMPTY_CHECKS) || 4; // 4 x 500ms = 2 s de queue vide → raccrocher juste après la fin de Minimax
                const MAX_CHECK_COUNT = 60; // 60 x 500ms = 30 s max pour que le TTS (Minimax) finisse
                const checkAudioAndHangup = () => {
                  if (!goodbyeDetected) {
                    if (goodbyeFallbackTimer) { clearTimeout(goodbyeFallbackTimer); goodbyeFallbackTimer = null; }
                    return;
                  }
                  const lastText = premiumTtsLastText || doneText || "";
                  const hasSaidGoodbye = isRealGoodbye(lastText);
                  if (!hasSaidGoodbye && checkCount === 0) {
                    console.log("👋 L'IA n'a pas encore dit 'au revoir', faire dire avant de raccrocher");
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                      const goodbyeMessage = {
                        type: "conversation.item.create",
                        item: {
                          type: "message",
                          role: "user",
                          content: [
                            {
                              type: "input_text",
                              text: "Au revoir"
                            }
                          ]
                        }
                      };
                      openaiWs.send(JSON.stringify(goodbyeMessage));
                      console.log("📤 Message 'Au revoir' envoyé à l'IA pour qu'elle réponde");
                      setTimeout(() => {
                        checkCount++;
                        checkAudioAndHangup();
                      }, 1500); // Attendre 1.5 secondes pour que l'IA commence à répondre
                      return;
                    } else {
                      console.warn("⚠️ Impossible d'envoyer 'au revoir' à l'IA (WebSocket fermé), raccrochage direct");
                      if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                      goodbyeFallbackTimer = null;
                      triggerHangup("auto_goodbye");
                      return;
                    }
                  }
                  const hasAudioPending = premiumTtsInFlight || premiumTtsQueue.length > 0 || outboundQueue.length > 0 || outboundQueuedBytes > 0;
                  if (hasAudioPending && checkCount < MAX_CHECK_COUNT) {
                    emptyChecksConsecutive = 0;
                    console.log("⏳ Audio encore en cours, attente...", { checkCount, premiumTtsInFlight, premiumTtsQueueLen: premiumTtsQueue.length, outboundQueueLen: outboundQueue.length, outboundQueuedBytes });
                    checkCount++;
                    setTimeout(checkAudioAndHangup, 500);
                    return;
                  }
                  if (!hasAudioPending) emptyChecksConsecutive++;
                  if (emptyChecksConsecutive < MIN_EMPTY_CHECKS && checkCount < MAX_CHECK_COUNT) {
                    checkCount++;
                    setTimeout(checkAudioAndHangup, 500);
                    return;
                  }
                  console.log("📞 Hangup automatique après détection fin d'échange (audio terminé ou timeout)", { checkCount, hadAudioPending: hasAudioPending, hasSaidGoodbye, emptyChecksConsecutive });
                  if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                  goodbyeFallbackTimer = null;
                  setTimeout(() => triggerHangup("auto_goodbye"), GOODBYE_POST_AUDIO_DELAY_MS);
                };
                const GOODBYE_INITIAL_DELAY_MS = Number(process.env.GOODBYE_INITIAL_DELAY_MS) || 3500;
                setTimeout(checkAudioAndHangup, GOODBYE_INITIAL_DELAY_MS);
              } else if (!isGoodbye && !goodbyeDetected && callDurationMs >= MIN_CALL_DURATION_MS && timeSinceLastUserActivity >= MIN_USER_INACTIVITY_FOR_GOODBYE_MS) {
                const clientText = doneText.toLowerCase();
                const saidYesForAppointment = /\b(oui|d'accord|ok|bien sûr|c'est bon|parfait|oui je veux|oui je veux bien)\b/i.test(clientText) && 
                                              (clientText.includes("rendez") || clientText.includes("rdv") || clientText.includes("rendez-vous"));
                const clientSaidNoMore = !saidYesForAppointment && (
                  /(non|pas|plus)\s+(besoin|rien|autre|d'autre)/i.test(clientText) || 
                  /c'est\s+tout/i.test(clientText) || 
                  /(non|pas)\s+(du\s+tout|maintenant)/i.test(clientText)
                );
                if (clientSaidNoMore) {
                  goodbyeDetected = true;
                  console.log("👋 Client a confirmé qu'il n'a plus besoin d'aide, faire dire 'au revoir' à l'IA avant de raccrocher");
                  if (goodbyeTimer) clearTimeout(goodbyeTimer);
                  if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                  goodbyeFallbackTimer = setTimeout(() => {
                    goodbyeFallbackTimer = null;
                    console.log("📞 Hangup fallback après au revoir (timeout " + GOODBYE_MAX_WAIT_MS + " ms)");
                    triggerHangup("auto_goodbye");
                  }, GOODBYE_MAX_WAIT_MS);
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    const goodbyeMessage = {
                      type: "conversation.item.create",
                      item: {
                        type: "message",
                        role: "user",
                        content: [
                          {
                            type: "input_text",
                            text: "Au revoir"
                          }
                        ]
                      }
                    };
                    openaiWs.send(JSON.stringify(goodbyeMessage));
                    console.log("📤 Message 'Au revoir' envoyé à l'IA pour qu'elle réponde");
                    setTimeout(() => {
                      let checkCount = 0;
                      let emptyChecksConsecutive = 0;
                      const MIN_EMPTY_CHECKS = Number(process.env.GOODBYE_MIN_EMPTY_CHECKS) || 4; // 4 x 500ms = 2 s queue vide → raccrocher après fin Minimax
                      const MAX_CHECK_COUNT = 60; // 60 x 500ms = 30 s max
                      const checkAudioAndHangupAfterGoodbye = () => {
                        const hasAudioPending = premiumTtsInFlight || premiumTtsQueue.length > 0 || outboundQueue.length > 0 || outboundQueuedBytes > 0;
                        if (hasAudioPending && checkCount < MAX_CHECK_COUNT) {
                          emptyChecksConsecutive = 0;
                          console.log("⏳ Attente que l'IA dise 'au revoir'...", { checkCount, premiumTtsInFlight, premiumTtsQueueLen: premiumTtsQueue.length, outboundQueueLen: outboundQueue.length, outboundQueuedBytes });
                          checkCount++;
                          setTimeout(checkAudioAndHangupAfterGoodbye, 500);
                          return;
                        }
                        if (!hasAudioPending) emptyChecksConsecutive++;
                        if (emptyChecksConsecutive < MIN_EMPTY_CHECKS && checkCount < MAX_CHECK_COUNT) {
                          checkCount++;
                          setTimeout(checkAudioAndHangupAfterGoodbye, 500);
                          return;
                        }
                        console.log("📞 Hangup automatique après que l'IA ait dit 'au revoir' (audio terminé ou timeout)", { checkCount, hadAudioPending: hasAudioPending, emptyChecksConsecutive });
                        if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                        goodbyeFallbackTimer = null;
                        setTimeout(() => triggerHangup("auto_goodbye"), GOODBYE_POST_AUDIO_DELAY_MS);
                      };
                      checkAudioAndHangupAfterGoodbye();
                    }, 1000); // Attendre 1 seconde pour que l'IA commence à répondre
                  } else {
                    console.warn("⚠️ Impossible d'envoyer 'au revoir' à l'IA (WebSocket fermé)");
                    if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                    goodbyeFallbackTimer = null;
                    triggerHangup("auto_goodbye");
                  }
                }
              } else if (isGoodbye && !goodbyeDetected) {
                const minDurationForLog = isGoodbye ? MIN_CALL_DURATION_FOR_GOODBYE_MS : MIN_CALL_DURATION_MS;
                console.log("⚠️ Fin d'échange détectée mais conditions non remplies:", {
                  callDuration: Math.round(callDurationMs / 1000) + "s (min: " + Math.round(minDurationForLog / 1000) + "s)",
                  userInactive: Math.round(timeSinceLastUserActivity / 1000) + "s (min: " + Math.round(MIN_USER_INACTIVITY_FOR_GOODBYE_MS / 1000) + "s)",
                  textPreview: doneText.substring(0, 100)
                });
              }
              if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                const textForTts = applyPricingHoursGuard(doneText);
                transcriptMap.set(rid, textForTts);
                flushRealtimeElevenChunks(rid, true);
              } else if (!rid || !spokenSet.has(rid)) {
                if (rid) spokenSet.add(rid);
                const alreadySpeaking = rid && spokenSet.has(rid);
                const textForTts = applyPricingHoursGuard(doneText);
                enqueueElevenLabsTts(textForTts, { interrupt: !alreadySpeaking });
              }
            }
          }
          if (msg.type === "conversation.item.done" && msg.item) {
            const item = msg.item;
            if (LOG_VERBOSE) {
              try {
                console.log("📨 conversation.item.done:", { role: item.role, itemId: item.id, responseId: msg.response_id ?? null });
              } catch {
                console.log("📨 conversation.item.done (simplifié)");
              }
            }
            if (item.role !== "assistant") {
              if (item.role === "user") {
                userHasSpoken = true;
                try {
                  let userText = "";
                  if (item.content) {
                    userText = extractTextFromResponseOutput(item.content);
                  }
                  if (!userText && typeof item.text === "string") {
                    userText = item.text;
                  }
                  if (userText && userText.trim() && !isJunkTranscript(userText)) {
                    const norm = userText.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
                    const dedupKey = "speak_" + norm;
                    if (!userSpeakItemIds.has(dedupKey)) {
                      userSpeakItemIds.add(dedupKey);
                      userSpeakCount++;
                      if (LOG_VERBOSE) console.log("📊 userSpeakCount (conversation.item.done):", userSpeakCount);
                    }
                    console.log("🟢 Le client a parlé (texte reçu par l'IA):", userText.substring(0, 120));
                    console.log(`[CLIENT-SAYS] ${userText}`);
                    lastUserTextPendingIngest = userText;
                    lastUserMessageText = userText;
                    const now = nowMs();
                    const timeSinceLastCommit = lastCommittedAt > 0 ? now - lastCommittedAt : Infinity;
                    if (timeSinceLastCommit > 2000) {
                      const oldLastCommittedAt = lastCommittedAt;
                      lastCommittedAt = now;
                      console.log("✅ lastCommittedAt mis à jour depuis conversation.item.done (user):", { 
                        text: userText.substring(0, 100), 
                        oldLastCommittedAt, 
                        lastCommittedAt,
                        timeSinceLastCommit 
                      });
                    }
                  } else if (userText && userText.trim()) {
                    console.log("⚠️ Transcription user ignorée (bruit détecté) depuis conversation.item.done:", userText.substring(0, 50));
                  }
                  if (userText && userText.trim() && consentRequired && !consentGiven) {
                    const ut = String(userText).toLowerCase().trim();
                    const utNorm = ut.replace(/\s+/g, " ").trim();
                    const acceptsConsent = /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|je l'accepte|voilà|voila|me convient|je suis d'accord)(\s+oui|\s+merci)?\.?$/i.test(utNorm)
                      || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|je l'accepte|voilà|voila|je suis d'accord)\b/i.test(ut)
                      || /\b(oui\s+)?(je\s+suis\s+d['']?accord|j['']?accepte)\b/i.test(ut)
                      || /\b(oui\s+)?(je\s+l['']?accepte)\b/i.test(ut);
                    const refusesConsent = /\b(non|nope|non merci|refuse|je refuse|pas d'accord|pas d'acc|ça ne me convient pas|ça ne va pas|je ne veux pas|je n'accepte pas)\b/i.test(ut) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(utNorm);
                    if (refusesConsent) {
                      console.log("🛑 Client refuse l'enregistrement (depuis conversation.item.done), message de refus puis raccrochage.", { userText: ut.substring(0, 80) });
                      playConsentRefusalAndHangup();
                    } else if (acceptsConsent) {
                      console.log("✅ Client accepte le consentement (depuis conversation.item.done).", { userText: ut.substring(0, 80) });
                      consentGiven = true;
                      playPostConsentGreeting();
                    }
                  }
                  if (userText && userText.trim()) {
                    const utPlate = String(userText).toLowerCase().trim().replace(/\s+/g, " ");
                    const confirmsPlatePatternsConv = [
                      /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila)(\s+oui|\s+c'est ça|\s+merci)?\.?$/i,
                      /\b(oui|ouais|ouai|c'est ça|c'est correct|c'est bien|oui c'est|oui c'est la bonne|oui voilà|oui c'est bon|voilà c'est ça|correct|exact|d'accord|très bien|parfait|bien sûr)\b/i,
                      /\b(c'est bien ça|c'est exact|tout à fait|parfait)\b/i
                    ];
                    const explicitOtherConv = /\b(ce n'est pas la bonne|pas la bonne|autre voiture|autre véhicule|j'ai changé de voiture)\b/i.test(utPlate);
                    const singleWordNoConv = /^\s*(non|nan|no)\s*$/i.test(utPlate);
                    const otherVehicleConv = explicitOtherConv || (userText.match(/\b(non|ce n'est pas)\b/i) && !singleWordNoConv);
                    const otherVehicleConvFinal = otherVehicleConv && !(singleWordNoConv && !explicitOtherConv);
                    const confirmsPlateConv = confirmsPlatePatternsConv.some(p => p.test(utPlate)) && !otherVehicleConvFinal;
                    if (confirmsPlateConv || (singleWordNoConv && !explicitOtherConv)) {
                      if (LOG_VERBOSE) console.log("✅ Client confirme la plaque (conversation.item.done), SMS non envoyé:", userText.substring(0, 60));
                      plateSmsSendOnFinalize = false;
                      plateSmsAlreadyMentioned = true;
                      plateConfirmedByClient = true;
                    }
                  }
                  if (userText && userText.trim() && consentGiven) {
                    const ut = String(userText).toLowerCase().trim().replace(/\s+/g, " ");
                    const isAffirmative = isAffirmativeFr(ut);
                    const looksAffirmative = /\b(oui|ouais|ouai|ok|d['']?accord|volontiers|avec plaisir)\b/i.test(ut);
                    const detectDevisIntent = (raw) => {
                      const q = String(raw || "").match(/[^?.!\n\r]*\?/g) || [];
                      const t = String(q.length ? q[q.length - 1] : raw).toLowerCase();
                      return /\b(devis)\b/.test(t) && (t.includes("souhaitez") || t.includes("voulez") || t.includes("demande"));
                    };
                    const lastIntentDevis = detectDevisIntent(lastAssistantText);
                    const recentIntentDevis = getMostRecentAssistantIntent(25000) === "devis";
                    if ((lastIntentDevis || recentIntentDevis) && (isAffirmative || looksAffirmative)) {
                      devisAcceptedByClient = true;
                      if (LOG_VERBOSE) console.log("ℹ️ Client a accepté une demande de devis (depuis conversation.item.done).", { userText: userText.substring(0, 40) });
                    }
                    if (!devisAcceptedByClient && lastAssistantText) {
                      const lastLow = String(lastAssistantText).toLowerCase();
                      const assistantAskedPlateConfirmation = (/\bplaque\b/.test(lastLow) || /\bimmatriculation\b/.test(lastLow)) && (/\best[- ]?ce\s+bien\s+correct\b/.test(lastLow) || /\bcorrect\b/.test(lastLow));
                      const inDevisContext = /\bdevis\b/.test(lastLow) || getMostRecentAssistantIntent(30000) === "devis";
                      const assistantAskedPlateForDevis = assistantAskedPlateConfirmation && inDevisContext;
                      const userGavePlate = /[A-Z]{2}[\s-]?\d{2,4}[\s-]?[A-Z]{2}/i.test(ut);
                      const userConfirmedShort = /^(euh\s+|ben\s+)?(oui|ouais|ouai|ok|voilà|voila|c'est ça|c'est bon)(\s+merci)?\.?$/i.test(ut) || /\b(oui|ouais|ouai|c'est ça|c'est correct|c'est bien)\b/i.test(ut);
                      if (assistantAskedPlateForDevis && (userGavePlate || userConfirmedShort)) {
                        devisAcceptedByClient = true;
                        if (LOG_VERBOSE) console.log("ℹ️ Devis demandé (plaque pour devis, depuis conversation.item.done).", { userText: userText.substring(0, 40) });
                      }
                    }
                    const clientAsksForRdv = /\b(je\s+)?(voudrais|veux|souhaite)\s+(prendre\s+)?(un\s+)?(rdv|rendez-?vous)\b/i.test(ut) || /\b(prendre|avoir)\s+(un\s+)?(rdv|rendez-?vous)\b/i.test(ut) || /\b(rdv|rendez-?vous)\s+(s['']il vous plaît|svp|merci)\b/i.test(ut) || /\bappel(le)?\s+pour\s+(un\s+)?(rdv|rendez-?vous)\b/i.test(ut);
                    if (clientAsksForRdv && !rdvRefusedByClient) {
                      rdvAcceptedByClient = true;
                      rdvRefusedByClient = false;
                      console.log("📌 [RDV] (conversation.item.done user) → rdv_accepted (client demande RDV)", { userText: userText.substring(0, 50) });
                    }
                    const clientAsksForDevis = /\b(j'?aimerais|je\s+voudrais|je\s+veux|je\s+souhaite)\s+(avoir\s+|faire\s+)?(une?\s+)?(demande\s+de\s+)?devis\b/i.test(ut) || /\b(avoir|obtenir)\s+(un\s+)?devis\b/i.test(ut) || /\bdevis\s+pour\s+(un\s+|le\s+)?(diagnostic|vidange|révision|frein)/i.test(ut);
                    if (clientAsksForDevis) {
                      devisAcceptedByClient = true;
                      if (LOG_VERBOSE) console.log("ℹ️ Client a demandé un devis directement (conversation.item.done).", { userText: userText.substring(0, 60) });
                    }
                    const detectRdvIntent = (raw) => {
                      const q = String(raw || "").match(/[^?.!\n\r]*\?/g) || [];
                      const t = String(q.length ? q[q.length - 1] : raw).toLowerCase();
                      const asksRdv = /\b(rendez-?vous|rdv|créneau)\b/.test(t) || /quel\s*jour|jour\s*vous\s*convient|matin|après-?midi/.test(t);
                      const asksCallback = /\b(rappel|rappeler)\b/.test(t);
                      return asksRdv && !asksCallback ? "rdv" : "unknown";
                    };
                    const lastIntentRdv = detectRdvIntent(lastAssistantText);
                    const recentIntentRdv = getMostRecentAssistantIntent(25000) === "rdv";
                    const inRdvFlow = lastIntentRdv === "rdv" || recentIntentRdv;
                    if (inRdvFlow && userText.trim()) {
                      const userGaveDayOrSlot = /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|demain|après-demain)\b/i.test(ut) || /\b(matin|après-midi)\b/i.test(ut);
                      const userAffirmativeConv = isAffirmativeFr(ut);
                      const userNegativeConv = isNegativeFr(ut);
                      const rdvPositive = /\b(oui|ouais|ok|d['']?accord|je veux|prendre rendez-vous|un rendez-vous)\b/i.test(ut);
                      const rdvNegative = /\b(non|pas de rendez-vous|pas maintenant|je ne veux pas de rendez-vous)\b/i.test(ut);
                      if (rdvNegative || (userNegativeConv && !userAffirmativeConv)) {
                        rdvRefusedByClient = true;
                        rdvAcceptedByClient = false;
                        console.log("📌 [RDV] (conversation.item.done user) → rdv_refused", { userText: userText.substring(0, 50) });
                      } else if (rdvPositive || (userAffirmativeConv && !userNegativeConv)) {
                        rdvAcceptedByClient = true;
                        rdvRefusedByClient = false;
                        console.log("📌 [RDV] (conversation.item.done user) → rdv_accepted (oui)", { userText: userText.substring(0, 50) });
                      } else if (userGaveDayOrSlot) {
                        rdvAcceptedByClient = true;
                        rdvRefusedByClient = false;
                        console.log("📌 [RDV] (conversation.item.done user) → rdv_accepted (jour/créneau)", { userText: userText.substring(0, 50) });
                      }
                    }
                  }
                } catch (e) {
                  console.error("❌ Erreur extraction texte user depuis conversation.item.done:", e);
                }
              }
            } else {
              if (initialAssistantGreetingText && !userHasSpoken) {
                console.log("👂 Ignorer conversation.item.done pour le greeting (déjà joué via Minimax).");
              } else {
                const rid = msg.response_id ?? null;
                let extracted = "";
                try {
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
                  if (LOG_VERBOSE) console.log("📝 Texte assistant depuis conversation.item.done:", clean.substring(0, 160));
                  if (isAssistantSayingValidationDevisTransfer(clean)) {
                    validationDevisByClient = true;
                    if (LOG_VERBOSE) console.log("ℹ️ Validation devis (IA dit mise en relation pour validation devis, conversation.item.done).", { text: clean.substring(0, 80) });
                  }
                  if (lastUserTextPendingIngest && lastUserTextPendingIngest.trim()) {
                    enqueueIngest("user", lastUserTextPendingIngest);
                    lastUserTextPendingIngest = null;
                  }
                  if (rid) {
                    const existing = transcriptMap.get(rid) || "";
                    transcriptMap.set(rid, (existing + " " + clean).trim());
                  }
                  if (REALTIME_USE_ELEVEN) {
                    const spokenSet = ws.__realtimeSpokenResponseId;
                    if (rid) {
                      if (!ws.__conversationItemTextByRid) ws.__conversationItemTextByRid = new Map();
                      const current = ws.__conversationItemTextByRid.get(rid) || "";
                      if (clean.length >= current.length) {
                        ws.__conversationItemTextByRid.set(rid, clean);
                      }
                      if (spokenSet && spokenSet.has(rid)) {
                        if (LOG_TTS) console.log(`[TTS] conversation.item.done buffer only (TTS déjà fait dans response.done):`, { rid, text: clean.substring(0, 80) });
                      } else {
                        if (LOG_TTS) console.log(`[TTS] conversation.item.done buffer (attente response.done):`, { rid, text: clean.substring(0, 80) });
                      }
                    }
                    if (!rid) {
                      if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(clean)) {
                        console.log("🛑 Réponse IA (conversation.item.done) = refus enregistrement, remplacement par message fixe.");
                        playConsentRefusalAndHangup();
                      } else if (consentRequired && !consentGiven && lastUserTextForConsent) {
                        const l = String(lastUserTextForConsent).toLowerCase().trim().replace(/\s+/g, " ");
                        const accepts = /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila|me convient)(\s+oui|\s+merci)?\.?$/i.test(l) || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|voilà|voila)\b/i.test(lastUserTextForConsent);
                        const refuses = /\b(non|nope|non merci|refuse|je refuse|pas d'accord|pas d'acc|ça ne me convient pas|ça ne va pas|je ne veux pas|je n'accepte pas)\b/i.test(lastUserTextForConsent) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(l);
                        if (!accepts && !refuses) {
                          console.log("🔄 Rappel consentement (conversation.item.done, client a dit autre chose):", lastUserTextForConsent.substring(0, 60));
                          enqueuePremiumTts(CONSENT_REMINDER, { interrupt: true, source: "consent_reminder", allowWithoutUser: true });
                        }
                        lastUserTextForConsent = null;
                      }
                      if (LOG_TTS) console.log(`[TTS] SKIPPED conversation.item.done (TTS assistant = response.done uniquement):`, { text: clean.substring(0, 80) });
                  }
                  }
                } else {
                  console.warn("⚠️ Aucun texte assistant extrait depuis conversation.item.done");
                  try {
                    console.log(
                      "📋 DEBUG conversation.item (assistant):",
                      JSON.stringify(item, null, 2).substring(0, 1200),
                    );
                  } catch {
                  }
                }
              }
            }
          }
          if (msg.type === "response.output_text.delta") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const delta = typeof msg.delta === "string" ? msg.delta : "";
            if (rid && delta && delta.trim()) {
              const current = transcriptMap.get(rid) || "";
              transcriptMap.set(rid, current + delta);
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          if (msg.type === "response.output_text.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const doneText = (rid ? (transcriptMap.get(rid) || "") : "") || (typeof msg.text === "string" ? msg.text : "");
            if (doneText && doneText.trim() && rid && !assistantTurnRids.has(rid)) {
              assistantTurnRids.add(rid);
              assistantTurnCount++;
              if (LOG_VERBOSE) console.log("📊 assistantTurnCount (response.output_text.done):", assistantTurnCount);
            }
            if (REALTIME_USE_ELEVEN && doneText && doneText.trim()) {
              if (ws.__consentRefused) {
                if (LOG_TTS) console.log("[TTS] Ignorer response.output_text.done (consentement refusé, message fixe en cours).");
              } else if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(doneText)) {
                console.log("🛑 Réponse IA (response.output_text.done) = refus enregistrement, remplacement par message fixe.");
                playConsentRefusalAndHangup();
              } else if (consentRequired && !consentGiven && lastUserTextForConsent) {
                const l = String(lastUserTextForConsent).toLowerCase().trim().replace(/\s+/g, " ");
                const accepts = /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila|me convient)(\s+oui|\s+merci)?\.?$/i.test(l) || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|voilà|voila)\b/i.test(lastUserTextForConsent);
                const refuses = /\b(non|nope|non merci|refuse|je refuse|pas d'accord|pas d'acc|ça ne me convient pas|ça ne va pas|je ne veux pas|je n'accepte pas)\b/i.test(lastUserTextForConsent) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(l);
                if (!accepts && !refuses) {
                  console.log("🔄 Rappel consentement (client a dit autre chose):", lastUserTextForConsent.substring(0, 60));
                  enqueuePremiumTts(CONSENT_REMINDER, { interrupt: true, source: "consent_reminder", allowWithoutUser: true });
                  lastUserTextForConsent = null;
                  return;
                }
                lastUserTextForConsent = null;
              } else {
              if (LOG_VERBOSE) console.log("📝 Réponse texte IA reçue (GPT-5):", doneText.substring(0, 100));
              if (lastUserTextPendingIngest && lastUserTextPendingIngest.trim()) {
                enqueueIngest("user", lastUserTextPendingIngest);
                lastUserTextPendingIngest = null;
              }
              const textForIngest = applyPricingHoursGuard(doneText);
              enqueueIngest("assistant", textForIngest);
              lastAssistantText = textForIngest; // Pour distinguer refus rappel vs refus consentement au prochain tour
              recordAssistantQuestionIntent(textForIngest);
              if (isAssistantConfirmingModificationRdv(doneText)) {
                modificationRdvByClient = true;
                annulationRdvByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ Modif. RDV (IA confirme demande de modification, output_text.done).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingAnnulationRdv(doneText)) {
                annulationRdvByClient = true;
                modificationRdvByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ Annul. RDV (IA confirme demande d'annulation, output_text.done).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingRdv(doneText)) {
                rdvAcceptedByClient = true;
                rdvRefusedByClient = false;
                if (LOG_VERBOSE) console.log("ℹ️ RDV demandé (IA confirme RDV noté, output_text.done).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantConfirmingDevis(doneText)) {
                devisAcceptedByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Devis demandé (IA confirme devis noté).", { text: doneText.substring(0, 60) });
              }
              if (isAssistantSayingValidationDevisTransfer(doneText)) {
                validationDevisByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Validation devis (IA dit mise en relation pour validation devis, output_text.done).", { text: doneText.substring(0, 80) });
              }
              const low = String(doneText || "").toLowerCase();
              const mentionsPlate = low.includes("plaque") || low.includes("immatric");
              const iaSaysWillSendSms = (low.includes("vais vous envoyer") || low.includes("va vous envoyer") || low.includes("vous envoie ") || low.includes("vous envoyer ") || low.includes("je vais vous envoyer") || low.includes("on va vous envoyer")) && (low.includes("message") || low.includes("sms") || low.includes("texte"));
              const offersToSend = iaSaysWillSendSms;
              const confirmsPlate = low.includes("oui c'est") || low.includes("c'est bien") || low.includes("c'est correct") || 
                                    low.includes("oui c'est la bonne") || low.includes("oui c'est pour cette voiture") ||
                                    low.includes("c'est correct") || low.includes("c'est ça") || low.includes("exact");
              const isRecapWithPlate = (low.includes("bien noté") || low.includes("bien note")) && mentionsPlate;
              if (isRecapWithPlate) {
                plateSmsSendOnFinalize = false;
                plateSmsAlreadyMentioned = true;
                if (LOG_VERBOSE) console.log("✅ Récap avec plaque (après confirmation), SMS non envoyé:", doneText.substring(0, 60));
              } else if (mentionsPlate && offersToSend && !plateSmsAlreadyMentioned && !confirmsPlate && !plateConfirmedByClient) {
                plateSmsSendOnFinalize = true;
                if (LOG_VERBOSE) console.log("📩 Détection « je vais vous envoyer un message/sms », SMS à la fin:", { offersToSend, textPreview: doneText.substring(0, 60) });
              } else if (confirmsPlate) {
                console.log("✅ IA confirme plaque existante, SMS non nécessaire:", { textPreview: doneText.substring(0, 100) });
                plateSmsSendOnFinalize = false;
                plateSmsAlreadyMentioned = true;
                plateConfirmedByClient = true; // IA confirme que le client a validé la plaque pour le RDV
              }
              const callDurationMs = nowMs() - callStartTimeMs;
              const timeSinceLastUserActivity = nowMs() - lastUserActivityMs;
              const isGoodbye = isRealGoodbye(doneText);
              const fullText = doneText.trim().toLowerCase();
              const hasQuestion = fullText.includes("?") || fullText.includes("comment") || fullText.includes("quel") || fullText.includes("pourquoi") || fullText.includes("quand") || fullText.includes("où");
              const isIncomplete = fullText.trim().endsWith(",") || fullText.trim().endsWith(":") || fullText.trim().endsWith("...");
              const goodbyePatternsForLog = [
                "au revoir", "aurevoir", 
                "merci et au revoir", "merci et bonne journée", "merci et bonne journee",
                "à très bientôt", "a tres bientot", "à plus tard", "a plus tard",
                "je vous souhaite une bonne journée", "je vous souhaite une bonne journee",
                "excellente journée", "excellente journee", "passez une bonne journée", "passez une bonne journee",
                "au revoir et bonne journée", "aurevoir et bonne journee", "au revoir, bonne journée", "aurevoir, bonne journee"
              ];
              const MIN_USER_INACTIVITY_FOR_GOODBYE_MS = 5000; // 5 secondes - attendre que le client ait fini de parler
              if (isGoodbye && !goodbyeDetected && callDurationMs >= MIN_CALL_DURATION_FOR_GOODBYE_MS) {
                goodbyeDetected = true;
                console.log("👋 Détection fin d'échange (au revoir détecté), hangup automatique après que l'audio soit terminé", {
                  callDuration: Math.round(callDurationMs / 1000) + "s",
                  userInactive: Math.round(timeSinceLastUserActivity / 1000) + "s",
                  textPreview: doneText.substring(0, 150)
                });
                if (goodbyeTimer) clearTimeout(goodbyeTimer);
                if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                goodbyeFallbackTimer = setTimeout(() => {
                  goodbyeFallbackTimer = null;
                  console.log("📞 Hangup fallback après au revoir (timeout " + GOODBYE_MAX_WAIT_MS + " ms)");
                  triggerHangup("auto_goodbye");
                }, GOODBYE_MAX_WAIT_MS);
                let checkCount = 0;
                let emptyChecksConsecutive = 0;
                const MIN_EMPTY_CHECKS = Number(process.env.GOODBYE_MIN_EMPTY_CHECKS) || 4; // 4 x 500ms = 2 s queue vide → raccrocher après fin Minimax
                const MAX_CHECK_COUNT = 60; // 60 x 500ms = 30 s max
                const checkAudioAndHangup = () => {
                  if (!goodbyeDetected) {
                    if (goodbyeFallbackTimer) { clearTimeout(goodbyeFallbackTimer); goodbyeFallbackTimer = null; }
                    return;
                  }
                  const lastText = premiumTtsLastText || doneText || "";
                  const hasSaidGoodbye = isRealGoodbye(lastText);
                  if (!hasSaidGoodbye && checkCount === 0) {
                    console.log("👋 L'IA n'a pas encore dit 'au revoir', faire dire avant de raccrocher");
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                      const goodbyeMessage = {
                        type: "conversation.item.create",
                        item: {
                          type: "message",
                          role: "user",
                          content: [{ type: "input_text", text: "Au revoir" }]
                        }
                      };
                      openaiWs.send(JSON.stringify(goodbyeMessage));
                      console.log("📤 Message 'Au revoir' envoyé à l'IA pour qu'elle réponde");
                      setTimeout(() => { checkCount++; checkAudioAndHangup(); }, 1500);
                      return;
                    } else {
                      console.warn("⚠️ Impossible d'envoyer 'au revoir' à l'IA (WebSocket fermé), raccrochage direct");
                      if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                      goodbyeFallbackTimer = null;
                      triggerHangup("auto_goodbye");
                      return;
                    }
                  }
                  const hasAudioPending = premiumTtsInFlight || premiumTtsQueue.length > 0 || outboundQueue.length > 0 || outboundQueuedBytes > 0;
                  if (hasAudioPending && checkCount < MAX_CHECK_COUNT) {
                    emptyChecksConsecutive = 0;
                    console.log("⏳ Audio encore en cours, attente...", { checkCount, premiumTtsInFlight, premiumTtsQueueLen: premiumTtsQueue.length, outboundQueueLen: outboundQueue.length, outboundQueuedBytes });
                    checkCount++;
                    setTimeout(checkAudioAndHangup, 500);
                    return;
                  }
                  if (!hasAudioPending) emptyChecksConsecutive++;
                  if (emptyChecksConsecutive < MIN_EMPTY_CHECKS && checkCount < MAX_CHECK_COUNT) {
                    checkCount++;
                    setTimeout(checkAudioAndHangup, 500);
                    return;
                  }
                  console.log("📞 Hangup automatique après détection fin d'échange (audio terminé ou timeout)", { checkCount, hadAudioPending: hasAudioPending, hasSaidGoodbye, emptyChecksConsecutive });
                  if (goodbyeFallbackTimer) clearTimeout(goodbyeFallbackTimer);
                  goodbyeFallbackTimer = null;
                  setTimeout(() => triggerHangup("auto_goodbye"), GOODBYE_POST_AUDIO_DELAY_MS);
                };
                setTimeout(checkAudioAndHangup, 2000); // Délai initial : laisser Minimax envoyer sa dernière phrase
              } else if (isGoodbye && !goodbyeDetected) {
                console.log("⚠️ Fin d'échange détectée mais conditions non remplies:", {
                  callDuration: Math.round(callDurationMs / 1000) + "s (min: " + Math.round(MIN_CALL_DURATION_MS / 1000) + "s)",
                  userInactive: Math.round(timeSinceLastUserActivity / 1000) + "s (min: " + Math.round(MIN_USER_INACTIVITY_FOR_GOODBYE_MS / 1000) + "s)",
                  textPreview: doneText.substring(0, 100)
                });
              }
              if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                const textForTts = applyPricingHoursGuard(doneText);
                transcriptMap.set(rid, textForTts);
                flushRealtimeElevenChunks(rid, true);
              }
              if (!REALTIME_ELEVEN_CHUNKING_ENABLED && consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(doneText)) {
                console.log("🛑 Réponse IA (response.output_text.done) = refus enregistrement, remplacement par message fixe.");
                playConsentRefusalAndHangup();
              }
              if (!REALTIME_ELEVEN_CHUNKING_ENABLED && consentRequired && !consentGiven && lastUserTextForConsent) {
                const l = String(lastUserTextForConsent).toLowerCase().trim().replace(/\s+/g, " ");
                const accepts = /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila|me convient)(\s+oui|\s+merci)?\.?$/i.test(l) || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|voilà|voila)\b/i.test(lastUserTextForConsent);
                const refuses = /\b(non|nope|non merci|refuse|je refuse|pas d'accord|pas d'acc|ça ne me convient pas|ça ne va pas|je ne veux pas|je n'accepte pas)\b/i.test(lastUserTextForConsent) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(l);
                if (!accepts && !refuses) {
                  console.log("🔄 Rappel consentement (client a dit autre chose, sans chunking):", lastUserTextForConsent.substring(0, 60));
                  enqueuePremiumTts(CONSENT_REMINDER, { interrupt: true, source: "consent_reminder", allowWithoutUser: true });
                }
                lastUserTextForConsent = null;
              }
              }
            }
          }
          if (msg.type === "response.content_part.added") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const part = msg.part;
            const text = (part && typeof part.text === "string" ? part.text : null) || 
                        (part && typeof part === "string" ? part : null) ||
                        (typeof msg.text === "string" ? msg.text : null);
            if (rid && text && text.trim()) {
              const current = transcriptMap.get(rid) || "";
              transcriptMap.set(rid, current + text);
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          if (msg.type === "response.content_part.done") {
            const rid = msg.response_id ?? msg.response?.id ?? null;
            const part = msg.part;
            const text = (part && typeof part.text === "string" ? part.text : null) || 
                        (part && typeof part === "string" ? part : null) ||
                        (typeof msg.text === "string" ? msg.text : null);
            if (rid && text && text.trim()) {
              const current = transcriptMap.get(rid) || "";
              if (!current.includes(text)) {
                transcriptMap.set(rid, current + text);
              }
              if (REALTIME_USE_ELEVEN && REALTIME_ELEVEN_CHUNKING_ENABLED) {
                flushRealtimeElevenChunks(rid, false);
              }
            }
          }
          if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") {
            console.log("🎵 Delta audio reçu:", {
              type: msg.type,
              hasDelta: !!msg.delta,
              hasAudio: !!msg.audio,
              hasChunk: !!msg.chunk,
              keys: Object.keys(msg).slice(0, 10),
            });
            if (REALTIME_USE_ELEVEN && nowMs() >= premiumTtsBypassUntilMs) {
              return;
            }
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
            if (msg.type === "response.output_item.done" && msg.item?.type === "function_call") {
              const callId = msg.item.call_id;
              const toolName = msg.item.name;
              const previousItemId = msg.item.id;
              const garageDataTools = ["get_garage_pricing", "get_opening_hours", "get_garage_services", "get_garage_faq", "get_garage_services_includes"];
              const restaurantDataTools = ["get_restaurant_info"];
              const dataTools = effectiveSector === "restaurant" ? restaurantDataTools : garageDataTools;
              if (dataTools.includes(toolName)) {
                const recentMs = 15000;
                const alreadySaidUnInstant = (premiumTtsLastText && /un\s+instant|instant\s+s'il\s+vous/i.test(premiumTtsLastText))
                  || recentAssistantTexts.some((t) => (Date.now() - t.ts) <= recentMs && /un\s+instant|instant\s+s'il\s+vous/i.test(t.text));
                if (!alreadySaidUnInstant) {
                  enqueuePremiumTts("D'accord, un instant s'il vous plaît.", { interrupt: false, source: "function_call_fallback", allowWithoutUser: true });
                }
              }
              let output = "";
              let transferOutputDeferred = false;
              if (toolName === "get_garage_pricing") {
                const raw = pricingSummary || "Tarifs non renseignés.";
                let prestation = "";
                try {
                  const args = msg.item.arguments ? (typeof msg.item.arguments === "string" ? JSON.parse(msg.item.arguments) : msg.item.arguments) : {};
                  prestation = String(args.prestation || "").trim().toLowerCase();
                } catch (_) { /* ignore */ }
                if (raw === "Tarifs non renseignés.") {
                  output = raw;
                  lastGaragePricingFallbackPhrase = "";
                  console.log("📌 get_garage_pricing:", { prestation, matched: "none", reason: "no_pricing" });
                } else if (prestation) {
                  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
                  let matched = null;
                  if (/disque/.test(prestation)) {
                    matched = lines.find(l => /^[^:]*disque/i.test(l) && /^[^:]*frein/i.test(l));
                  }
                  if (!matched && (/plaquette|frein/.test(prestation) && !/disque/.test(prestation))) {
                    matched = lines.find(l => /^[^:]*plaquette/i.test(l) && /^[^:]*frein/i.test(l) && !/^[^:]*disque/i.test(l));
                  }
                  if (!matched && /diagnostic/.test(prestation)) matched = lines.find(l => /^[^:]*diagnostic/i.test(l));
                  if (!matched && /vidange/.test(prestation)) matched = lines.find(l => /^[^:]*vidange/i.test(l));
                  if (!matched && /r[eé]vision/.test(prestation)) matched = lines.find(l => /^[^:]*r[eé]vision/i.test(l));
                  if (matched) {
                    const matchedForSpeech = matched
                      .replace(/\s*\(\s*\d+\s*h(?:\s*\d+)?\s*min\s*\)\s*$/i, "")
                      .replace(/\s*\(\s*\d+\s*min\s*\)\s*$/i, "")
                      .trim();
                    const colonIdx = matchedForSpeech.indexOf(":");
                    const serviceName = colonIdx >= 0 ? matchedForSpeech.substring(0, colonIdx).trim() : prestation;
                    let pricePart = colonIdx >= 0 ? matchedForSpeech.substring(colonIdx + 1).trim() : "";
                    pricePart = pricePart.replace(/(\d)O(?=\s|à|€|$)/gi, "$10"); // Corriger 5O -> 50
                    const article = /\b(vidange|révision)\b/i.test(serviceName) ? "la " : /\b(plaquettes|disques)\b/i.test(serviceName) ? "les " : "le ";
                    const rangeMatch = pricePart.match(/de\s*(\d+)\s*à\s*(\d+)/i) || pricePart.match(/De\s*(\d+)\s*à\s*(\d+)/);
                    let fallbackPrice = "";
                    if (rangeMatch) {
                      const low = Number(rangeMatch[1]);
                      const high = Number(rangeMatch[2]);
                      fallbackPrice = `entre ${numberToFrenchWordsTts(low)} et ${numberToFrenchWordsTts(high)} euros`;
                      lastGaragePricingFallbackPhrase = `Le tarif pour ${article}${serviceName.toLowerCase()} est ${fallbackPrice}. Avez-vous besoin d'autre chose ?`;
                    } else {
                      const singleMatch = pricePart.match(/(\d+)\s*€/);
                      if (singleMatch) {
                        fallbackPrice = `${numberToFrenchWordsTts(Number(singleMatch[1]))} euros`;
                        lastGaragePricingFallbackPhrase = `Le tarif pour ${article}${serviceName.toLowerCase()} est de ${fallbackPrice}. Avez-vous besoin d'autre chose ?`;
                      } else {
                        fallbackPrice = pricePart.replace(/\s*\([^)]*\)\s*/g, " ").trim() || "varie";
                        lastGaragePricingFallbackPhrase = "";
                      }
                    }
                    const stateLine = garageClosed ? "État actuel: le garage est actuellement FERMÉ." : "État actuel: le garage est actuellement OUVERT.";
                    const hoursBlock = [garageHoursText || "Horaires non renseignés.", closedDaysText ? `Jours de fermeture: ${closedDaysText}` : "", stateLine].filter(Boolean).join("\n");
                    output = `TARIF et HORAIRES:\n\nTARIF:\n${matchedForSpeech}\n\nHORAIRES:\n${hoursBlock}\n\nRÈGLE OBLIGATOIRE: Tu DOIS TOUJOURS annoncer le tarif au client. Pour les horaires, dis-les en toutes lettres (ex: de huit heures trente à midi et de quatorze heures à dix-huit heures) — jamais "8h30" ou "14h" seuls. Si le client a demandé UNIQUEMENT le tarif (sans vouloir de rendez-vous): annonce UNIQUEMENT le tarif puis dis "Avez-vous besoin d'autre chose ?". Ne reste JAMAIS silencieux. Ne demande PAS le jour, PAS la plaque (ne dis JAMAIS "Je vois que vous êtes déjà dans nos dossiers" ni "Est-ce bien correct ?" pour la plaque). Si le client a demandé un rendez-vous: annonce tarif + horaires (en toutes lettres) puis demande "Quel jour vous conviendrait le mieux ?".`;
                    console.log("📌 get_garage_pricing:", {
                      prestation,
                      matchedLine: matchedForSpeech.substring(0, 80),
                      hoursPreview: (garageHoursText || "").substring(0, 80),
                    });
                  } else {
                    output = raw;
                    lastGaragePricingFallbackPhrase = "";
                    console.log("📌 get_garage_pricing:", { prestation, matched: "none", reason: "no_match", linesCount: lines.length });
                  }
                } else {
                  output = `ERREUR - PRESTATION MANQUANTE: Tu DOIS rappeler get_garage_pricing en passant le paramètre prestation. Valeurs possibles: plaquettes, freins, diagnostic, vidange, révision, disques (selon la demande du client: ex. "changement des plaquettes" ou "plaquettes de frein" → prestation: "plaquettes"). Ne donne aucun tarif ni horaires au client avant d'avoir rappelé get_garage_pricing avec la bonne prestation.`;
                  lastGaragePricingFallbackPhrase = "";
                  console.log("📌 get_garage_pricing:", { prestation: "(vide)", reason: "prestation_required" });
                }
              }
              else if (toolName === "get_garage_services") output = servicesSummary || "Services non renseignés.";
              else if (toolName === "get_garage_faq") output = faqsSummary || "FAQ non renseignée.";
              else if (toolName === "get_opening_hours") {
                const stateLine = garageClosed ? "État actuel: le garage est actuellement FERMÉ (hors horaires ou vacances)." : "État actuel: le garage est actuellement OUVERT.";
                output = [garageHoursText || "Horaires non renseignés.", closedDaysText ? `Jours de fermeture: ${closedDaysText}` : "", stateLine].filter(Boolean).join("\n");
              }
              else if (toolName === "get_garage_services_includes") output = [servicesIncludesSummary || "", servicesRequiringStockSummary ? `Prestations avec stock: ${servicesRequiringStockSummary}` : ""].filter(Boolean).join("\n") || "Prestations incluses non renseignées.";
              else if (toolName === "get_restaurant_info") {
                const menuText = String(menuSummary || (process.env.MENU_SUMMARY ?? faqsSummary ?? "")).trim();
                const stateLine = garageClosed ? "État actuel: le restaurant est actuellement FERMÉ." : "État actuel: le restaurant est actuellement OUVERT.";
                output = [menuText ? `MENU: ${menuText}` : "", garageHoursText ? `HORAIRES: ${garageHoursText}` : "Horaires non renseignés.", closedDaysText ? `Jours de fermeture: ${closedDaysText}` : "", stateLine].filter(Boolean).join("\n");
              }
              else if (toolName === "transfer_to_restaurant") {
                try {
                  const baseUrl = (typeof autoguruIngestUrl === "string" && autoguruIngestUrl) ? autoguruIngestUrl.replace(/\/api\/twilio\/realtime-ingest.*$/, "").replace(/\/$/, "") : "";
                  const token = (typeof autoguruIngestToken === "string" && autoguruIngestToken) ? autoguruIngestToken : "";
                  const prevItemId = previousItemId;
                  if (baseUrl && token && callSid && garageId) {
                    transferOutputDeferred = true;
                    transferTriggered = true;
                    enqueuePremiumTts("Transfert vers le restaurant, un instant.", { interrupt: true, source: "transfer_to_restaurant", allowWithoutUser: true });
                    const waitForOutboundDrain = () => {
                      if (outboundQueuedBytes === 0 && outboundQueue.length === 0) {
                        fetch(`${baseUrl}/api/twilio/call-transfer`, {
                          method: "POST",
                          headers: autoguruApiHeaders(),
                          body: JSON.stringify({ callSid, garageId, token, ...(callToken ? { callToken } : {}) }),
                        }).then(async (res) => {
                          const data = await res.json().catch(() => ({}));
                          const out = (res.ok && data.ok) ? "Transfert en cours. L'appel est redirigé vers le restaurant." : "Le transfert n'a pas pu être effectué. Propose de prendre un message.";
                          try {
                            openaiWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: out }, previous_item_id: prevItemId }));
                          } catch (e) { /* ignore */ }
                        }).catch(() => {
                          try {
                            openaiWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: "Transfert impossible. Propose de prendre un message." }, previous_item_id: prevItemId }));
                          } catch (e) { /* ignore */ }
                        });
                        return;
                      }
                      setTimeout(waitForOutboundDrain, 200);
                    };
                    waitForOutboundDrain();
                    output = "Transfert annoncé.";
                  } else output = "Transfert non configuré.";
                } catch (_) { output = "Transfert impossible."; }
              }
              else if (toolName === "transfer_to_garage") {
                try {
                  const args = msg.item.arguments ? (typeof msg.item.arguments === "string" ? JSON.parse(msg.item.arguments) : msg.item.arguments) : {};
                  if (args.validation_devis === true) {
                    validationDevisByClient = true;
                    if (LOG_VERBOSE) console.log("ℹ️ Validation devis (IA a passé validation_devis: true dans transfer_to_garage).");
                  }
                } catch (_) { /* ignore */ }
                const baseUrl = (typeof autoguruIngestUrl === "string" && autoguruIngestUrl) ? autoguruIngestUrl.replace(/\/api\/twilio\/realtime-ingest.*$/, "").replace(/\/$/, "") : "";
                const token = (typeof autoguruIngestToken === "string" && autoguruIngestToken) ? autoguruIngestToken : "";
                const prevItemId = previousItemId;
                if (baseUrl && token && callSid && garageId) {
                  transferOutputDeferred = true;
                  const ttsPhrase = validationDevisByClient ? "D'accord, je vais vous mettre en relation avec le garage pour la validation de votre devis." : "Transfert vers le garage, un instant.";
                  enqueuePremiumTts(ttsPhrase, {
                    interrupt: true,
                    source: "transfer_to_garage",
                    allowWithoutUser: true,
                    onComplete: () => {
                      const waitForOutboundDrain = () => {
                        if (outboundQueuedBytes === 0 && outboundQueue.length === 0) {
                          transferTriggered = true; // AVANT le fetch : au redirect client vers hold, le stream s'arrête ; on doit déjà avoir le flag pour différer le finalize
                          fetch(`${baseUrl}/api/twilio/call-transfer`, {
                            method: "POST",
                            headers: autoguruApiHeaders(),
                            body: JSON.stringify({ callSid, garageId, token, ...(callToken ? { callToken } : {}), ...(validationDevisByClient ? { validation_devis: true } : {}) }),
                          }).then(async (res) => {
                            const data = await res.json().catch(() => ({}));
                            let out = "";
                            if (res.ok && data.ok) {
                              out = "Transfert en cours. L'appel est en train d'être redirigé vers le garage.";
                              console.log("✅ Transfert vers le garage déclenché:", callSid);
                            } else {
                              out = validationDevisByClient
                                ? "Le transfert n'a pas pu être effectué. Tu DOIS dire EXACTEMENT au client: 'Le garage ne répond pas mais j'ai pris note pour votre demande, une personne vous rappellera le plus vite que possible.' Ne propose PAS le rappel."
                                : "Le transfert n'a pas pu être effectué. Propose au client que le garage le rappelle.";
                              transferToGarageStatus = "failure";
                              transferTriggered = false; // pas de redirect → stream peut encore être actif ; on ne diffère pas le finalize
                              console.warn("⚠️ call-transfer échec:", res.status, data);
                            }
                            try {
                              openaiWs.send(JSON.stringify({
                                type: "conversation.item.create",
                                item: { type: "function_call_output", call_id: callId, output: out },
                                previous_item_id: prevItemId,
                              }));
                              if (!res.ok || !data.ok) {
                                setTimeout(() => {
                                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !responseInProgress) requestResponseCreate("after_transfer_failed");
                                }, 150);
                              }
                            } catch (e) { console.error("❌ Envoi function_call_output (transfer):", e); }
                          }).catch((err) => {
                            console.error("❌ Erreur call-transfer:", err);
                            transferToGarageStatus = "failure";
                            transferTriggered = false;
                            const out = validationDevisByClient
                              ? "Le transfert n'a pas pu être effectué. Tu DOIS dire EXACTEMENT au client: 'Le garage ne répond pas mais j'ai pris note pour votre demande, une personne vous rappellera le plus vite que possible.' Ne propose PAS le rappel."
                              : "Le transfert n'a pas pu être effectué. Propose au client que le garage le rappelle.";
                            try {
                              openaiWs.send(JSON.stringify({
                                type: "conversation.item.create",
                                item: { type: "function_call_output", call_id: callId, output: out },
                                previous_item_id: prevItemId,
                              }));
                              setTimeout(() => {
                                if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !responseInProgress) requestResponseCreate("after_transfer_failed");
                              }, 150);
                            } catch (e) { console.error("❌ Envoi function_call_output (transfer):", e); }
                          });
                          return;
                        }
                        setTimeout(waitForOutboundDrain, 200);
                      };
                      waitForOutboundDrain();
                    },
                  });
                  output = "Transfert annoncé. En attente de la fin de l'annonce puis redirection.";
                } else {
                  transferToGarageStatus = "failure";
                  output = "Transfert non configuré (URL ou token manquant). Propose au client que le garage le rappelle.";
                }
              } else output = "Outil inconnu.";
              if (LOG_VERBOSE) console.log("🔧 Tool call:", toolName, "→", output.length, "car.");
              if (!transferOutputDeferred) {
                try {
                  const garageDataTools = ["get_garage_pricing", "get_opening_hours", "get_garage_services", "get_garage_faq", "get_garage_services_includes"];
                  if (garageDataTools.includes(toolName)) {
                    lastGarageToolOutputAt = nowMs();
                  }
                  openaiWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: { type: "function_call_output", call_id: callId, output },
                    previous_item_id: previousItemId,
                  }));
                  let attempt = 0;
                  const maxAttempts = 5;
                  const delayMs = garageDataTools.includes(toolName) ? 2500 : 150; // Laisser finir "Un instant" avant de demander la suite
                  const scheduleResponseAfterTool = () => {
                    attempt += 1;
                    if (openaiWs && openaiWs.readyState === WebSocket.OPEN && !responseInProgress) {
                      if (garageDataTools.includes(toolName)) pendingGaragePricingResponseAt = nowMs();
                      requestResponseCreate("after_function_call_output");
                    } else if (openaiWs && openaiWs.readyState === WebSocket.OPEN && responseInProgress && attempt < maxAttempts) {
                      setTimeout(scheduleResponseAfterTool, 200);
                    }
                  };
                  setTimeout(scheduleResponseAfterTool, delayMs);
                } catch (err) {
                  console.error("❌ Envoi function_call_output:", err);
                }
              }
            } else if (msg.item) {
              if (LOG_VERBOSE) {
                console.log("✅ Réponse IA:", msg.type, msg.item?.type);
                if (msg.item) console.log("📋 Détails item réponse:", { type: msg.item.type, hasContent: !!msg.item.content, keys: Object.keys(msg.item) });
              }
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
                if (extractedText.trim()) {
                  if (isAssistantSayingValidationDevisTransfer(extractedText)) {
                    validationDevisByClient = true;
                    if (LOG_VERBOSE) console.log("ℹ️ Validation devis (IA dit mise en relation pour validation devis, output_item).", { text: extractedText.substring(0, 80) });
                  }
                }
                if (extractedText.trim() && REALTIME_USE_ELEVEN) {
                  if (LOG_VERBOSE) console.log("📝 Texte extrait depuis output_item:", extractedText.substring(0, 100));
                  if (rid) {
                    transcriptMap.set(rid, extractedText);
                  }
                  if (consentRequired && !consentGiven && looksLikeAssistantResponseToRefusal(extractedText)) {
                    console.log("🛑 Réponse IA (response.output_item.done) = refus enregistrement, remplacement par message fixe.");
                    playConsentRefusalAndHangup();
                  } else if (REALTIME_ELEVEN_CHUNKING_ENABLED && rid) {
                    flushRealtimeElevenChunks(rid, msg.type === "response.output_item.done");
                  } else if ((!rid || !spokenSet.has(rid)) && !REALTIME_USE_ELEVEN) {
                    if (rid) spokenSet.add(rid);
                    enqueuePremiumTts(extractedText, { interrupt: msg.type === "response.output_item.done", source: msg.type, responseId: rid });
                  }
                }
              }
            }
          }
          const isNoisyOutputDelta = msg.type === "response.output_text.delta" || msg.type === "response.audio_transcript.delta";
          if (msg.type && (msg.type.includes("audio") || msg.type.includes("output")) && !isNoisyOutputDelta) {
            if (LOG_VERBOSE) console.log("🔊 Message audio/output:", msg.type, { hasDelta: !!msg.delta, hasAudio: !!msg.audio, keys: Object.keys(msg).slice(0, 10) });
          }
          if (msg.type === "conversation.item.input_audio_transcription.completed") {
            const transcript = msg.transcript;
            const isJunk = isJunkTranscript(transcript);
            if (!isJunk) {
              console.log("🟢 Le client a parlé (transcription complétée):", (transcript ?? "").substring(0, 120));
              console.log(`[CLIENT-SAYS] (input_audio_transcription) ${transcript ?? ""}`);
            }
            const transcriptTrimmed = transcript && transcript.trim();
            const shouldUpdate = transcriptTrimmed && !isJunk;
            if (shouldUpdate) {
              const oldLastCommittedAt = lastCommittedAt;
              lastCommittedAt = nowMs();
              userHasSpoken = true;
              lastUserActivityMs = nowMs();
              lastUserMessageText = String(transcript || "").trim();
              const norm = String(transcript).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
              const dedupKey = "speak_" + norm;
              if (!userSpeakItemIds.has(dedupKey)) {
                userSpeakItemIds.add(dedupKey);
                userSpeakCount++;
                if (LOG_VERBOSE) console.log("📊 userSpeakCount (input_audio_transcription):", userSpeakCount);
              }
              console.log("✅ Transcription utilisateur reçue, lastCommittedAt mis à jour:", { transcript: transcript.substring(0, 100), lastCommittedAt, oldLastCommittedAt });
            } else if (transcriptTrimmed) {
              console.log("⚠️ Transcription ignorée (bruit détecté):", transcript.substring(0, 50));
            } else {
            }
            const userText = String(transcript || "").toLowerCase().trim();
            const userTextNorm = userText.replace(/\s+/g, " ").trim();
            const acceptsConsent = /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|je l'accepte|d'accord pour l'enregistrement|cela me convient|ça me convient|me convient|voilà|voila|je suis d'accord)(\s+oui|\s+merci)?\.?$/i.test(userTextNorm)
              || /\b(oui|ouais|ouai|ok|d'accord|dac|bien sûr|c'est bon|vas[- ]y|allez|ça marche|accepte|j'accepte|je l'accepte|voilà|voila|je suis d'accord)\b/i.test(userText)
              || /\b(oui\s+)?(je\s+suis\s+d['']?accord|j['']?accepte)\b/i.test(userText)
              || /\b(oui\s+)?(je\s+l['']?accepte)\b/i.test(userText);
            const userAffirmative = isAffirmativeFr(userTextNorm);
            const userNegative = isNegativeFr(userTextNorm);
            const detectLastQuestionIntent = (assistantText) => {
              const raw = String(assistantText || "");
              const questions = raw.match(/[^?.!\n\r]*\?/g) || [];
              const target = String(questions.length ? questions[questions.length - 1] : raw).toLowerCase().trim();
              const asksNeedOther = /\b(besoin\s+d'?autre\s+chose|autre\s+chose)\b/.test(target) || /d'?autre\s+chose\s*\?/.test(target);
              if (asksNeedOther) return "need_other";
              const asksDevis = /\b(devis)\b/.test(target) && (target.includes("souhaitez") || target.includes("voulez") || target.includes("demande"));
              const asksCallback = /\b(rappel|rappeler|rappelé|recontact|recontacter)\b/.test(target);
              const asksRdv = /\b(rendez-?vous|rdv|créneau)\b/.test(target) || /quel\s*jour|jour\s*vous\s*convient|matin|après-?midi/.test(target);
              if (asksDevis) return "devis";
              if (asksCallback && !asksRdv) return "callback";
              if (asksRdv && !asksCallback) return "rdv";
              if (asksCallback && asksRdv) {
                return target.lastIndexOf("rappel") >= target.lastIndexOf("rendez-vous") ? "callback" : "rdv";
              }
              return "unknown";
            };
            const lastIntent = detectLastQuestionIntent(lastAssistantText);
            const recentIntent = getMostRecentAssistantIntent(25000);
            const effectiveIntent = lastIntent !== "unknown" ? lastIntent : recentIntent;
            const lastWasCallbackQuestionIntent = effectiveIntent === "callback";
            const lastWasDevisQuestionIntent = effectiveIntent === "devis";
            const lastWasRdvQuestionIntent = effectiveIntent === "rdv";
            const lastWasInRdvFlowIntent = effectiveIntent === "rdv";
            const clientAsksForRdvInput = /\b(je\s+)?(voudrais|veux|souhaite)\s+(prendre\s+)?(un\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm) || /\b(prendre|avoir)\s+(un\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm) || /\b(rdv|rendez-?vous)\s+(s['']il vous plaît|svp|merci)\b/i.test(userTextNorm) || /\bappel(le)?\s+pour\s+(un\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm);
            if (clientAsksForRdvInput && !rdvRefusedByClient) {
              rdvAcceptedByClient = true;
              rdvRefusedByClient = false;
              console.log("📌 [RDV] (input_audio_transcription) → rdv_accepted (client demande RDV)", { userText: userTextNorm?.slice(0, 50) });
            }
            const clientAsksForDevisInput = /\b(j'?aimerais|je\s+voudrais|je\s+veux|je\s+souhaite)\s+(avoir\s+|faire\s+)?(une?\s+)?(demande\s+de\s+)?devis\b/i.test(userTextNorm) || /\b(avoir|obtenir)\s+(un\s+)?devis\b/i.test(userTextNorm) || /\bdevis\s+pour\s+(un\s+|le\s+)?(diagnostic|vidange|révision|frein)/i.test(userTextNorm);
            if (clientAsksForDevisInput) {
              devisAcceptedByClient = true;
              if (LOG_VERBOSE) console.log("ℹ️ Client a demandé un devis directement (devis_requested).", { userText: userTextNorm?.slice(0, 60) });
            }
            if (lastWasRdvQuestionIntent || lastWasInRdvFlowIntent) {
              console.log("📌 [RDV] Intention RDV détectée:", { lastIntent, recentIntent, effectiveIntent, lastAssistantSnippet: (lastAssistantText || "").slice(0, 100) });
            }
            const callbackExplicitPositive = /\b(oui|ouais|ok|d['’]?accord|je veux|oui je veux|volontiers|avec plaisir|rappeler moi|rappellez moi|rappeler)\b/i.test(userTextNorm);
            const callbackExplicitNegative = /\b(non|pas besoin|pas de rappel|ne me rappelez pas|je ne veux pas être rappel[ée]?)\b/i.test(userTextNorm);
            const rdvExplicitPositive = /\b(oui|ouais|ok|d['’]?accord|je veux|prendre rendez-vous|un rendez-vous)\b/i.test(userTextNorm);
            const rdvExplicitNegative = /\b(non|pas de rendez-vous|pas maintenant|je ne veux pas de rendez-vous)\b/i.test(userTextNorm);
            const clientWantsRecallNow = (/\b(rappeler|rappel|rappellera|être rappelé)\b/i.test(userTextNorm)) && (/\b(oui|ouais|ouai|je veux|si je veux|volontiers|d['']?accord)\b/i.test(userTextNorm));
            if (clientWantsRecallNow) {
              callbackAcceptedByClient = true;
              callbackRefusedByClient = false;
              maybeSpeakCallbackAck();
            }
            const looksLikeAffirmativeForCallback = /\b(oui|ouais|ouai|ok|d['']?accord|volontiers|avec plaisir)\b/i.test(userTextNorm);
            const looksLikeRefuseForCallback = /\b(non|pas besoin|pas de rappel|ne me rappelez pas)\b/i.test(userTextNorm) && !/\b(oui|ouais|ouai)\b/i.test(userTextNorm);
            if (lastWasCallbackQuestionIntent && !clientWantsRecallNow) {
              if (callbackExplicitPositive || (userAffirmative && !userNegative) || looksLikeAffirmativeForCallback) {
                callbackAcceptedByClient = true;
                callbackRefusedByClient = false;
                maybeSpeakCallbackAck();
              } else if ((callbackExplicitNegative || (userNegative && !userAffirmative)) && looksLikeRefuseForCallback) {
                callbackRefusedByClient = true;
                callbackAcceptedByClient = false;
                maybeSpeakCallbackAck();
              }
            }
            if (lastWasRdvQuestionIntent || lastWasInRdvFlowIntent) {
              const userGaveDayOrSlot = /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|demain|après-demain)\b/i.test(userTextNorm) || /\b(matin|après-midi)\b/i.test(userTextNorm);
              console.log("📌 [RDV] Bloc RDV évalué:", { lastWasRdvQuestionIntent, lastWasInRdvFlowIntent, userText: userTextNorm?.slice(0, 60), userGaveDayOrSlot, rdvExplicitPositive, userAffirmative, userNegative });
              if (rdvExplicitNegative || (userNegative && !userAffirmative)) {
                rdvRefusedByClient = true;
                rdvAcceptedByClient = false;
                console.log("📌 [RDV] → rdv_refused (client a refusé)");
              } else if (rdvExplicitPositive || (userAffirmative && !userNegative)) {
                rdvAcceptedByClient = true;
                rdvRefusedByClient = false;
                console.log("📌 [RDV] → rdv_accepted (oui explicite)");
              } else if (lastWasInRdvFlowIntent) {
                if (userGaveDayOrSlot) {
                  rdvAcceptedByClient = true;
                  rdvRefusedByClient = false;
                  console.log("📌 [RDV] → rdv_accepted (client a indiqué jour/créneau)", { userText: userText?.substring(0, 50) });
                }
              }
            }
            if (lastWasDevisQuestionIntent && (rdvExplicitPositive || userAffirmative || looksLikeAffirmativeForCallback)) {
              devisAcceptedByClient = true;
              if (LOG_VERBOSE) console.log("ℹ️ Client a accepté une demande de devis.", { userText: userText?.substring(0, 40) });
            }
            const lastQuestionWasDevis = lastIntent === "devis";
            if (lastQuestionWasDevis && (callbackExplicitNegative || looksLikeRefuseForCallback || /\b(pas de devis|sans devis|non merci)\b/i.test(userTextNorm))) {
              devisAcceptedByClient = false;
              if (LOG_VERBOSE) console.log("ℹ️ Client a refusé la demande de devis.", { userText: userText?.substring(0, 40) });
            }
            const userWantsModifyRdv = /\b(modifier|changer|déplacer|reporter|décaler)\s+(mon\s+)?(rdv|rendez-?vous|créneau|date)\b/i.test(userTextNorm) || /\b(je\s+veux\s+)?(modifier|changer)\s+(le\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm);
            const userWantsCancelRdv = /\b(annuler|annulation)\s+(mon\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm) || /\b(je\s+veux\s+)?annuler\s+(le\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm) || /\bplus\s+besoin\s+(du\s+)?(rdv|rendez-?vous)\b/i.test(userTextNorm);
            const lastAst = String(lastAssistantText || "");
            const assistantAskedModify = lastAst && (
              /\b(modifier|changer|déplacer|reporter)\s+(votre\s+)?(rdv|rendez-?vous)\b/i.test(lastAst) ||
              (/\b(déplacer|modifier|changer|reporter)\b/i.test(lastAst) && /\b(rdv|rendez-?vous|créneau|date)\b/i.test(lastAst))
            );
            const assistantAskedCancel = lastAssistantText && /\b(annuler|annulation)\s+(votre\s+)?(rdv|rendez-?vous)\b/i.test(String(lastAssistantText));
            const isOnlyConsentPhrase = /^(oui\s+)?(je\s+)?suis\s+d'?accord\.?$/i.test(userTextNorm) || /^d'?accord\.?$/i.test(userTextNorm) || /^oui\s+d'?accord\.?$/i.test(userTextNorm);
            const userSaidYesToModifyOrCancel = (userAffirmative || rdvExplicitPositive) && !isOnlyConsentPhrase;
            if (userWantsModifyRdv || (assistantAskedModify && userSaidYesToModifyOrCancel)) {
              modificationRdvByClient = true;
              annulationRdvByClient = false;
              if (LOG_VERBOSE) console.log("ℹ️ Demande de modification de RDV.", { userText: userText?.substring(0, 50) });
            }
            if (userWantsCancelRdv || (assistantAskedCancel && userSaidYesToModifyOrCancel)) {
              annulationRdvByClient = true;
              modificationRdvByClient = false;
              if (LOG_VERBOSE) console.log("ℹ️ Demande d'annulation de RDV.", { userText: userText?.substring(0, 50) });
            }
            const userWantsValidateDevis = /\b(valider|confirmer|accepter)\s+(le\s+|mon\s+|un\s+)?devis\b/i.test(userTextNorm) ||
              /\b(aimerais|voudrais|veux|souhaite)\s+(valider|confirmer|accepter)\s+(un\s+|mon\s+|le\s+)?devis\b/i.test(userTextNorm) ||
              /\bj'appelle\s+pour\s+valider\s+(mon\s+)?devis\b/i.test(userTextNorm) ||
              /\bdevis\s+(que\s+)?(le\s+garage\s+)?(m['']a\s+)?(a\s+)?(fait|établi|envoyé)\b/i.test(userTextNorm) ||
              (/\bj'ai\s+reçu\s+(le\s+)?devis\b/i.test(userTextNorm) && /\b(je\s+)?(confirme|valide|accepte)\b/i.test(userTextNorm)) ||
              (/\bdevis\s+(déjà\s+)?(établi|envoyé|reçu)\b/i.test(userTextNorm) && /\b(valider|confirmer|accepter)\b/i.test(userTextNorm));
            if (userWantsValidateDevis) {
              validationDevisByClient = true;
              if (LOG_VERBOSE) console.log("ℹ️ Validation de devis (client appelle pour valider un devis déjà établi).", { userText: userText?.substring(0, 50) });
            }
            if (!devisAcceptedByClient && lastAssistantText) {
              const lastLow = lastAssistantText.toLowerCase();
              const assistantAskedPlateConfirmation = (/\bplaque\b/.test(lastLow) || /\bimmatriculation\b/.test(lastLow)) && (/\best[- ]?ce\s+bien\s+correct\b/.test(lastLow) || /\bcorrect\b/.test(lastLow));
              const inDevisContext = /\bdevis\b/.test(lastLow) || getMostRecentAssistantIntent(30000) === "devis";
              const assistantAskedPlateForDevis = assistantAskedPlateConfirmation && inDevisContext;
              const userGavePlate = /[A-Z]{2}[\s-]?\d{2,4}[\s-]?[A-Z]{2}/i.test(userTextNorm);
              const userConfirmedShort = /^(euh\s+|ben\s+)?(oui|ouais|ouai|ok|voilà|voila|c'est ça|c'est bon)(\s+merci)?\.?$/i.test(userTextNorm) || /\b(oui|ouais|ouai|c'est ça|c'est correct|c'est bien)\b/i.test(userTextNorm);
              if (assistantAskedPlateForDevis && (userGavePlate || userConfirmedShort)) {
                devisAcceptedByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Devis demandé (plaque donnée/confirmée pour le devis).", { userText: userText?.substring(0, 40) });
              }
            }
            const refusesConsent = (userNegative || userText.match(/\b(non|nope|non merci|refuse|je refuse|pas d'accord|pas d'acc|ça ne me convient pas|ça ne va pas|je ne veux pas|je n'accepte pas)\b/i)) && !/^(oui|ouais|ouai|ok|nan)\s*$/i.test(userTextNorm);
            if (refusesConsent && consentRequired && !consentGiven) {
              const lastIntentForConsent = detectLastQuestionIntent(lastAssistantText);
              const recentIntentForConsent = getMostRecentAssistantIntent(25000);
              const effectiveIntentForConsent = lastIntentForConsent !== "unknown" ? lastIntentForConsent : recentIntentForConsent;
              const lastWasCallbackQuestion = effectiveIntentForConsent === "callback";
              const lastWasRdvQuestion = effectiveIntentForConsent === "rdv";
              const lastWasInRdvFlow = effectiveIntentForConsent === "rdv";
              if (lastWasCallbackQuestion) {
                callbackRefusedByClient = true; // Pour finalize → callback_type "none" et badge "Pas rappel"
                if (LOG_VERBOSE) console.log("ℹ️ Client a refusé le rappel (pas l'enregistrement), on laisse l'IA conclure.", { userText: userText?.substring(0, 40) });
              } else if (lastWasRdvQuestion || lastWasInRdvFlow) {
                rdvRefusedByClient = true; // Pour finalize → rdv_requested false, pas de point RDV
                if (LOG_VERBOSE) console.log("ℹ️ Client a refusé le rendez-vous (pas l'enregistrement), on laisse l'IA conclure.", { userText: userText?.substring(0, 40) });
              } else {
                console.log("🛑 Client refuse l'enregistrement (transcription), message de refus puis raccrochage.", { userText });
                playConsentRefusalAndHangup();
              }
            } else if (consentGiven && refusesConsent) {
              const lastAssistantAskedPlateConfirmation = lastAssistantText && /\b(est-ce bien correct|correcte?)\b/i.test(String(lastAssistantText)) && /\b(plaque|immatriculation)\b/i.test(String(lastAssistantText));
              const lastIntentAfterConsent = detectLastQuestionIntent(lastAssistantText);
              const recentIntentAfterConsent = getMostRecentAssistantIntent(25000);
              const effectiveIntentAfterConsent = lastIntentAfterConsent !== "unknown" ? lastIntentAfterConsent : recentIntentAfterConsent;
              const lastWasRdvQuestion = effectiveIntentAfterConsent === "rdv";
              const lastWasInRdvFlow = effectiveIntentAfterConsent === "rdv";
              const lastWasCallbackQuestion = effectiveIntentAfterConsent === "callback";
              const transcriptLooksRefuse = /\b(non|pas besoin|pas de rappel)\b/i.test(userTextNorm) && !/\b(oui|ouais|ouai)\b/i.test(userTextNorm);
              if ((lastWasRdvQuestion || lastWasInRdvFlow) && !lastAssistantAskedPlateConfirmation) {
                rdvRefusedByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Client a refusé le rendez-vous.", { userText: userText?.substring(0, 40) });
              }
              if (lastWasCallbackQuestion && transcriptLooksRefuse) {
                callbackRefusedByClient = true;
                if (LOG_VERBOSE) console.log("ℹ️ Client a refusé le rappel.", { userText: userText?.substring(0, 40) });
              }
            } else if (acceptsConsent && consentRequired && !consentGiven) {
              console.log("✅ Client accepte le consentement, ne plus redemander:", { userText });
              consentGiven = true;
              lastUserTextForConsent = null;
              playPostConsentGreeting();
            } else if (consentRequired && !consentGiven && userText && userText.trim()) {
              lastUserTextForConsent = userText;
            }
            const confirmsPlatePatterns = [
              /^(euh\s+|ben\s+|ah\s+)?(oui|ouais|ouai|ok|d'accord|dac|voilà|voila)(\s+oui|\s+c'est ça|\s+c'est bon|\s+merci)?\.?$/i,
              /\b(oui|ouais|ouai|c'est ça|c'est correct|c'est bien|oui c'est|oui c'est la bonne|oui c'est pour cette voiture|correct|exact|oui c'est bien|oui c'est la même|oui c'est celle-là|oui voilà|oui c'est bon|voilà c'est ça|d'accord|très bien|parfait|bien sûr|volontiers)\b/i,
              /\b(oui|ouais|ouai|exactement|précisément)\s+(c'est|c'est bien|c'est correct|c'est la bonne|c'est pour cette voiture)\b/i,
              /\b(c'est bien ça|c'est exact|tout à fait|parfait)\b/i
            ];
            const confirmsPlate = confirmsPlatePatterns.some(pattern => pattern.test(userTextNorm));
            const explicitOtherVehicle = /\b(ce n'est pas la bonne|pas la bonne|autre voiture|autre véhicule|j'ai changé de voiture|nouvelle voiture|nouveau véhicule|c'est une autre|c'est pour un autre)\b/i.test(userTextNorm);
            const singleWordNo = /^\s*(non|nan|no)\s*$/i.test(userTextNorm);
            const otherVehicle = explicitOtherVehicle || (userText.match(/\b(non|ce n'est pas)\b/i) && !singleWordNo && !confirmsPlate);
            const otherVehicleFinal = otherVehicle && !(singleWordNo && !explicitOtherVehicle);
            if (confirmsPlate && !otherVehicleFinal) {
              if (LOG_VERBOSE) console.log("✅ Client confirme la plaque, désactivation SMS:", userText?.substring(0, 60));
              plateSmsSendOnFinalize = false;
              plateSmsAlreadyMentioned = true; // Éviter de proposer à nouveau
              plateConfirmedByClient = true;   // RDV: ne pas envoyer de SMS, valider la plaque en dossier
            } else if (singleWordNo && !explicitOtherVehicle) {
              if (LOG_VERBOSE) console.log("✅ Réponse courte « non » après question plaque → considérée comme confirmation (évite faux négatif STT):", userText?.substring(0, 40));
              plateSmsSendOnFinalize = false;
              plateSmsAlreadyMentioned = true;
              plateConfirmedByClient = true;
            } else if (otherVehicleFinal && !confirmsPlate) {
              console.log("🚗 Client demande un autre véhicule, l'IA devrait proposer d'envoyer un message pour plate_2:", { userText });
            }
          }
          if (msg.type === "error") {
            const err = msg.error || {};
            console.error("❌ Erreur OpenAI:", err.code || "?", err.message || err, err.param ? `(param: ${err.param})` : "");
            const errParam = String(msg?.error?.param ?? "");
            const errCode = String(msg?.error?.code ?? "");
            if (errCode === "unknown_parameter" && errParam.startsWith("session.")) {
              if (!ws.__didSessionFallback) {
                ws.__didSessionFallback = true;
                console.warn("↩️ Fallback session.update (minimal) après unknown_parameter:", { errParam });
                try {
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
          if (msg.type === "input_audio_buffer.speech_started") {
            const shouldIgnore = INPUT_GATE_ENABLED && lastInputAudioLevel < INPUT_SPEECH_THRESHOLD;
            if (shouldIgnore) {
              console.log("🔇 Ignoré speech_started OpenAI (faux positif, niveau audio trop faible:", lastInputAudioLevel, "<", INPUT_SPEECH_THRESHOLD + ")");
              return;
            }
            console.log("🟢 Le client a parlé (détection début parole OpenAI - speech_started)", { niveau: lastInputAudioLevel, seuil: INPUT_SPEECH_THRESHOLD });
            speechActive = true;
            lastSpeechTs = nowMs();
            awaitingUserResponse = true;
            bytesSinceSpeechStart = 0;
            userHasSpoken = true;
          }
          if (msg.type === "input_audio_buffer.speech_stopped") {
            speechActive = false;
          }
          if (msg.type === "input_audio_buffer.committed") {
            appendedBytes = 0;
            const COMMIT_SPEECH_WINDOW_MS = Number(process.env.COMMIT_SPEECH_WINDOW_MS ?? "15000");
            const hasRealSpeech = speechActive || (nowMs() - lastSpeechTs) < COMMIT_SPEECH_WINDOW_MS;
            if (hasRealSpeech) {
              const commitTs = nowMs();
              lastCommitAt = commitTs; // Pour que le watchdog envoie response.create (lastCommittedAt n'est mis à jour qu'après le transcript)
              console.log("🟢 Le client a parlé (buffer audio envoyé au modèle - committed)", { item_id: msg.item_id, timeSinceSpeech: commitTs - lastSpeechTs });
              if (LOG_VERBOSE) console.log("✅ OpenAI buffer committed:", { item_id: msg.item_id, previous_item_id: msg.previous_item_id, timeSinceSpeech: commitTs - lastSpeechTs });
              const canRequest = (commitTs - lastResponseAt) > 600;
              if (awaitingUserResponse && canRequest) {
                lastResponseAt = commitTs;
                awaitingUserResponse = false;
                setTimeout(() => {
                  if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
                  if (responseInProgress) return;
                  if (lastResponseCreatedAt >= lastCommitAt) return;
                  requestResponseCreate("watchdog_after_commit");
                }, WATCHDOG_AFTER_COMMIT_MS);
              }
            } else {
              if (LOG_VERBOSE) console.log("⚠️ OpenAI buffer committed IGNORÉ (pas de parole réelle):", { item_id: msg.item_id, timeSinceSpeech: nowMs() - lastSpeechTs });
            }
          }
          if (msg.type === "response.created") {
            responseInProgress = true;
            activeResponseId = msg.response?.id ?? msg.response_id ?? null;
            lastResponseCreatedAt = nowMs();
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
        const isTimeoutClose = connectionTimeoutTriggered || (err.message && err.message.includes("closed before the connection was established"));
        if (isTimeoutClose) {
          console.warn("⚠️ OpenAI WS: connexion interrompue (timeout ou fermeture avant établissement) — souvent dû à latence réseau Render↔OpenAI");
        } else {
          console.error("❌ Erreur OpenAI WS:", err);
          console.error("❌ OpenAI WS error details:", {
            message: err.message,
            code: err.code,
            stack: err.stack?.substring(0, 500),
          });
        }
        const shouldRetry = err.message && (
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("ETIMEDOUT") ||
          err.message.includes("ENOTFOUND") ||
          err.message.includes("closed before the connection was established")
        );
        if (shouldRetry) {
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
          const msg = code === 1006
            ? (connectionTimeoutTriggered ? "⚠️ Timeout connexion OpenAI (1006) — augmenter OPENAI_WS_CONNECTION_TIMEOUT_MS si récurrent" : "❌ Connexion OpenAI fermée avant établissement (1006) — vérifier OPENAI_API_KEY et connectivité réseau")
            : "⚠️ OpenAI WS fermé anormalement (code != 1000)";
          console.warn(msg);
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
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        const streamCallSid = msg.start?.callSid;
        twilioStreamSid = msg.start?.streamSid ?? null;
        const startParams = msg.start?.customParameters || {};
        const finalCallSid = startParams.callSid || callSid || streamCallSid;
        const finalGarageId = startParams.garageId || garageId;
        const finalGarageName = startParams.garageName || garageName;
        const finalFromNumber = startParams.fromNumber || fromNumber;
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
        const finalAllowTransfer = startParams.allowTransfer || "";
        const finalTransferFailed = startParams.transfer_failed || "";
        const finalValidationDevis = startParams.validation_devis || "";
        const finalCollectVehicleInfo = startParams.collectVehicleInfo || "";
        const finalPricingSummary = startParams.pricingSummary || "";
        const finalServicesSummary = startParams.servicesSummary || "";
        const finalServicesRequiringStockSummary = startParams.servicesRequiringStockSummary || "";
        const finalServicesIncludesSummary = startParams.servicesIncludesSummary || "";
        const finalFaqsSummary = startParams.faqsSummary || "";
        const finalMenuSummary = startParams.menuSummary || "";
        const finalClosedDaysText = startParams.closedDaysText || "";
        const finalCallToken = startParams.callToken || "";
        const finalLunchFullToday = startParams.lunchFullToday || "";
        const finalDinnerFullToday = startParams.dinnerFullToday || "";
        const finalLunchPassedForToday = startParams.lunchPassedForToday || "";
        const finalGarageType = String(startParams.garageType || "").trim().toLowerCase();
        if (finalGarageType === "restaurant") effectiveSector = "restaurant";
        console.log("🏷️ Secteur effectif:", effectiveSector, "(garageType reçu:", finalGarageType || "non fourni", ")");
        callStartIso = startParams.callStartIso || "";
        console.log("🎬 Stream start:", {
          streamCallSid,
          streamSid: twilioStreamSid,
          callSid: finalCallSid,
          garageId: finalGarageId,
          garageName: finalGarageName,
          fromNumber: finalFromNumber,
          garageClosed: finalGarageClosed,
          garageClosedReason: finalGarageClosedReason,
          allowTransfer: finalAllowTransfer,
          transferFailed: finalTransferFailed === "true",
          collectVehicleInfo: finalCollectVehicleInfo,
          hasPricingSummary: Boolean(finalPricingSummary && String(finalPricingSummary).trim()),
          customParameters: startParams,
          mediaFormat: msg.start?.mediaFormat
        });
        callSid = finalCallSid;
        latestStreamStartTimeByCallSid.set(finalCallSid, callStartTimeMs); // pour ne pas envoyer finalize différé si un stream plus récent existe
        garageId = finalGarageId;
        garageName = finalGarageName;
        fromNumber = finalFromNumber;
        if (typeof finalIngestUrl === "string" && finalIngestUrl.trim()) autoguruIngestUrl = finalIngestUrl.trim();
        if (typeof finalIngestToken === "string" && finalIngestToken.trim()) autoguruIngestToken = finalIngestToken.trim();
        if (typeof finalAssistantName === "string" && finalAssistantName.trim()) assistantName = finalAssistantName.trim();
        if (typeof finalAssistantVoice === "string" && finalAssistantVoice.trim()) assistantVoice = finalAssistantVoice.trim().toLowerCase();
        if (typeof finalGarageTone === "string") garageTone = finalGarageTone.trim();
        if (typeof finalConsentRequired === "string" && finalConsentRequired.trim()) consentRequired = finalConsentRequired.trim().toLowerCase() === "true";
        if (typeof finalAppointmentMode === "string" && finalAppointmentMode.trim()) {
          const raw = finalAppointmentMode.trim();
          appointmentMode = raw === "internal" ? "request" : raw;
        }
        if (typeof finalGarageClosed === "string" && finalGarageClosed.trim()) garageClosed = finalGarageClosed.trim().toLowerCase() === "true";
        if (typeof finalGarageClosedReason === "string") garageClosedReason = String(finalGarageClosedReason || "").trim();
        if (typeof finalGarageClosedText === "string") garageClosedText = String(finalGarageClosedText || "").trim();
        if (typeof finalGarageHoursText === "string") garageHoursText = String(finalGarageHoursText || "").trim();
        if (typeof finalClosedDaysText === "string") closedDaysText = String(finalClosedDaysText || "").trim();
        if (typeof finalLunchFullToday === "string" && finalLunchFullToday.trim()) lunchFullToday = finalLunchFullToday.trim().toLowerCase() === "true";
        if (typeof finalDinnerFullToday === "string" && finalDinnerFullToday.trim()) dinnerFullToday = finalDinnerFullToday.trim().toLowerCase() === "true";
        let lunchPassedForToday = false;
        if (typeof finalLunchPassedForToday === "string" && finalLunchPassedForToday.trim()) lunchPassedForToday = finalLunchPassedForToday.trim().toLowerCase() === "true";
        if (typeof finalAllowTransfer === "string" && finalAllowTransfer.trim()) allowTransfer = finalAllowTransfer.trim().toLowerCase() === "true";
        if (garageClosed) allowTransfer = false; // Sécurité : transfert toujours interdit quand le garage est fermé (horaires ou vacances)
        transferFailed = typeof finalTransferFailed === "string" && finalTransferFailed.trim().toLowerCase() === "true";
        if (typeof finalValidationDevis === "string" && finalValidationDevis.trim().toLowerCase() === "true") validationDevisByClient = true;
        if (transferFailed) {
          transferToGarageStatus = "failure"; // Session reconnexion après transfert raté → finalize enverra "failure"
          transferTriggered = true; // pour envoyer transfer_to_garage: true au finalize
          consentGiven = true; // Client avait déjà donné son accord dans l'appel initial → ne pas redemander le consentement ni rejouer la phrase d'accueil
          const existingTimer = deferredFinalizeTimersByCallSid.get(finalCallSid);
          if (existingTimer) {
            clearTimeout(existingTimer);
            deferredFinalizeTimersByCallSid.delete(finalCallSid);
            console.log("⏳ Timer finalize différé annulé (2e stream reconnect):", finalCallSid);
          }
        }
        if (typeof finalCollectVehicleInfo === "string" && finalCollectVehicleInfo.trim()) collectVehicleInfo = finalCollectVehicleInfo.trim().toLowerCase() === "true";
        if (typeof finalPricingSummary === "string") pricingSummary = String(finalPricingSummary || "").trim();
        if (typeof finalServicesSummary === "string") servicesSummary = String(finalServicesSummary || "").trim();
        if (typeof finalServicesRequiringStockSummary === "string") servicesRequiringStockSummary = String(finalServicesRequiringStockSummary || "").trim();
        if (typeof finalServicesIncludesSummary === "string") servicesIncludesSummary = String(finalServicesIncludesSummary || "").trim();
        if (typeof finalFaqsSummary === "string") faqsSummary = String(finalFaqsSummary || "").trim();
        if (typeof finalMenuSummary === "string") menuSummary = String(finalMenuSummary || "").trim();
        if (typeof finalCallToken === "string" && finalCallToken.trim()) callToken = String(finalCallToken).trim();
        if (transferFailed) {
          const transferFailedMsg = validationDevisByClient
            ? "Le garage ne répond pas mais j'ai pris note pour votre demande, une personne vous rappellera le plus vite que possible. Avez-vous besoin d'autre chose ?"
            : "Le garage n'a pas répondu. Voulez-vous être rappelé par le garage ?";
          initialAssistantGreetingText = transferFailedMsg;
          hasSentInitialGreeting = true;
          if (PREMIUM_TTS_ENABLED) {
            enqueuePremiumTts(transferFailedMsg, { interrupt: true, source: "transfer_failed", allowWithoutUser: true });
          } else if (typeof enqueueElevenLabsTts === "function") {
            enqueueElevenLabsTts(transferFailedMsg, { interrupt: true });
          }
          if (typeof markGreeted === "function") markGreeted(callSid, Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000)));
          console.log("🔄 Message transfert raté joué (reconnexion après pas de réponse garage).", { callSid });
        }
        (async () => {
          try {
            console.log("🔍 Tentative récupération infos client:", {
              garageId: finalGarageId,
              fromNumber: finalFromNumber,
              hasSecret: !!AUTOGURU_INGEST_SECRET_ENV,
              hasIngestUrl: !!autoguruIngestUrl,
            });
            const secretToUse = AUTOGURU_INGEST_SECRET_ENV || "";
            const tokenToUse = autoguruIngestToken || "";
            if (finalGarageId && finalFromNumber && autoguruIngestUrl) {
              const baseUrl = autoguruIngestUrl.replace(/\/api\/twilio\/realtime-ingest.*$/, "");
              let clientInfoUrl = `${baseUrl}/api/twilio/client-info?garageId=${encodeURIComponent(finalGarageId)}&phoneNumber=${encodeURIComponent(finalFromNumber)}`;
              if (!secretToUse && tokenToUse) {
                clientInfoUrl += `&token=${encodeURIComponent(tokenToUse)}`;
              } else if (!secretToUse && !tokenToUse) {
                console.warn("⚠️ Pas de secret ni token pour client-info, skip");
                return;
              }
              console.log("🔍 Appel API client-info:", clientInfoUrl.replace(/secret=\S+|token=\S+/, "***"));
              const headers = {};
              if (RUN_ANALYSIS_SECRET_ENV) headers["Authorization"] = "Bearer " + RUN_ANALYSIS_SECRET_ENV;
              if (secretToUse) headers["x-secret"] = secretToUse;
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
                  const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
                  const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
                  if (ws.__greetingFallbackTimer) {
                    clearTimeout(ws.__greetingFallbackTimer);
                    ws.__greetingFallbackTimer = null;
                    console.log("👋 Timer greeting fallback annulé (client-info a joué le greeting générique).");
                  }
                  if (!transferFailed && !hasGreetedRecently(callSid) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN && !initialAssistantGreetingText) {
                    const isRestoCI = effectiveSector === "restaurant";
                    const placePart = getPlaceLabelForGreeting(garageName, effectiveSector);
                    let greeting;
                    if (consentRequired && !consentGiven) {
                      const baseHello = isRestoCI
                        ? `Bonjour. ${assistantName} du ${placePart}.`
                        : `Bonjour. Ici ${assistantName} du ${placePart}.`;
                      const consentText = (isRestoCI ? "Cet appel est enregistré pour préparer votre réservation. " : "Cet appel est enregistré pour préparer votre arrivée au garage. ") + CONSENT_MAIN;
                      greeting = [baseHello, consentText].filter(Boolean).join(" ");
                    } else if (isRestoCI) {
                      const rawN = String(garageName || "").trim();
                      const lbl = /^restaurant\b/i.test(rawN) ? rawN : `restaurant ${rawN}`;
                      if (clientInfo.name) {
                        const nameParts = clientInfo.name.split(/\s+/).filter(p => p.trim().length > 0);
                        const lastName = clientInfo.last_name?.trim() || nameParts[nameParts.length - 1] || clientInfo.name;
                        const title = clientInfo.gender === "homme" ? "Monsieur" : clientInfo.gender === "femme" ? "Madame" : "";
                        const salutation = title ? `${title} ${lastName}` : lastName;
                        greeting = `Bonjour ${salutation}. ${assistantName} du ${lbl}, je vous écoute.`;
                      } else {
                        greeting = `${lbl}, ${assistantName} à l'appareil. Je vous écoute.`;
                      }
                    } else {
                      const baseHello = `Bonjour. Ici ${assistantName} du ${placePart}.`;
                      greeting = clientInfo.name ? (() => {
                        const nameParts = clientInfo.name.split(/\s+/).filter(p => p.trim().length > 0);
                        const lastName = clientInfo.last_name?.trim() || nameParts[nameParts.length - 1] || clientInfo.name;
                        const title = clientInfo.gender === "homme" ? "Monsieur" : clientInfo.gender === "femme" ? "Madame" : "";
                        const salutation = title ? `${title} ${lastName}` : lastName;
                        return `Bonjour ${salutation}. Ici ${assistantName} du ${placePart}. En quoi puis-je vous aider ?`;
                      })() : baseHello + " En quoi puis-je vous aider ?";
                    }
                    initialAssistantGreetingText = greeting;
                    hasSentInitialGreeting = true;
                    enqueuePremiumTts(greeting, { interrupt: true, source: "initial_greeting", allowWithoutUser: true });
                    const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
                    console.log(`👋 Greeting ${consentRequired && !consentGiven ? "générique (consent)" : "post-consent avec nom"} joué via ${providerName}.`, { callSid, consentRequired });
                    if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
                  } else if (!transferFailed && !rdvNotificationFollowupPlayed && (initialAssistantGreetingText || hasGreetedRecently(callSid)) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN && (!consentRequired || consentGiven)) {
                    const appointments = clientInfo.appointments || [];
                    if (appointments.length > 0) {
                      const apt = appointments[0];
                      if (apt.en_attente_confirmation_garage !== true) {
                        rdvNotificationFollowupPlayed = true;
                        const date = new Date(apt.appointment_date);
                        const dateStr = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
                        const aptTime = (apt.appointment_time || "").slice(0, 5);
                        const rdvNotification = `Je vois que vous avez un rendez-vous enregistré pour le ${dateStr} à ${aptTime}. En quoi puis-je vous aider ?`;
                        enqueuePremiumTts(rdvNotification, { interrupt: true, source: "rdv_notification_followup", allowWithoutUser: true });
                        console.log("👋 Notification RDV enregistré jouée (consentement donné).", { callSid });
                      }
                    }
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
        logPipelineConfigOnce("⚙️ Pipeline actif");
        try {
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          const fallbackDelayMs = Number(process.env.GREETING_FALLBACK_DELAY_MS ?? "900");
          if (!transferFailed && (!greetOncePerCall || !hasGreetedRecently(callSid)) && PREMIUM_TTS_ENABLED && REALTIME_USE_ELEVEN && !initialAssistantGreetingText) {
            ws.__greetingFallbackTimer = setTimeout(() => {
              if (initialAssistantGreetingText || clientInfo) return;
              const isRestoFb = effectiveSector === "restaurant";
              const placePart = getPlaceLabelForGreeting(garageName, effectiveSector);
              let greeting;
              if (consentRequired && !consentGiven) {
                const baseHello = isRestoFb
                  ? `Bonjour. ${assistantName} du ${placePart}.`
                  : `Bonjour. Ici ${assistantName} du ${placePart}.`;
                const consentText = (isRestoFb ? "Cet appel est enregistré pour préparer votre réservation. " : "Cet appel est enregistré pour préparer votre arrivée au garage. ") + CONSENT_MAIN;
                greeting = [baseHello, consentText].filter(Boolean).join(" ");
              } else if (isRestoFb) {
                const rawN = String(garageName || "").trim();
                const lbl = /^restaurant\b/i.test(rawN) ? rawN : `restaurant ${rawN}`;
                greeting = `${lbl}, ${assistantName} à l'appareil. Je vous écoute.`;
              } else {
                const baseHello = `Bonjour. Ici ${assistantName} du ${placePart}.`;
                const question = ["Qu'est-ce qui vous amène ?", "Dites-moi ce qui se passe.", "Je vous écoute."][Math.floor(Math.random() * 3)];
                greeting = [baseHello, question].filter(Boolean).join(" ");
              }
              initialAssistantGreetingText = greeting;
              hasSentInitialGreeting = true;
              enqueuePremiumTts(greeting, { interrupt: true, source: "initial_greeting", allowWithoutUser: true });
              const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
              console.log(`👋 Greeting générique (sans nom client) joué APRÈS délai fallback via ${providerName}.`, { callSid, consentRequired, fallbackDelayMs });
              if (greetOncePerCall) markGreeted(callSid, greetTtlMs);
              ws.__greetingFallbackTimer = null;
            }, fallbackDelayMs);
          }
        } catch (e) {
          const providerName = PREMIUM_TTS_PROVIDER === "minimax" ? "Minimax" : "ElevenLabs";
          console.error(`❌ Erreur greeting immédiat ${providerName}:`, e);
        }
        if (PIPELINE_MODE === "stt_llm_tts") {
          const greetOncePerCall = (process.env.GREETING_ONCE_PER_CALL ?? "true").toLowerCase() === "true";
          const greetTtlMs = Number(process.env.GREETING_ONCE_TTL_MS ?? String(10 * 60 * 1000));
          if (!transferFailed && (!greetOncePerCall || !hasGreetedRecently(callSid))) {
            const greetingDelayMs = Number(process.env.GREETING_DELAY_MS ?? "150");
            setTimeout(() => {
              const rawName = String(garageName || "AutoGuru").trim();
              const label = effectiveSector === "restaurant"
                ? (/^restaurant\b/i.test(rawName) ? rawName : `Restaurant ${rawName}`)
                : (/^garage\b/i.test(rawName) ? rawName : `Garage ${rawName}`);
              const variations = effectiveSector === "restaurant"
                ? [
                    `${label}, ${assistantName} à l'appareil. Je vous écoute.`,
                    `Bonjour, ${label}, ${assistantName}. Qu'est-ce que je peux faire pour vous ?`,
                    `${label} bonjour, ${assistantName} à l'appareil. Je vous écoute.`,
                    `Bonjour, ici ${label}. ${assistantName}, je vous écoute.`,
                  ]
                : [
                    `Oui allô, bonjour. Ici ${label}. Je vous écoute.`,
                    `Bonjour. ${label}. Dites-moi ce qui se passe.`,
                    `Oui bonjour, ${label}. Qu'est-ce qui vous amène ?`,
                    `Bonjour, vous êtes bien chez ${label}. Alors, c'est pour la voiture ?`,
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
          connectToOpenAI();
        }
        if (!outboundTimer) {
          outboundTimer = setInterval(() => {
            try {
              const backlogFrames = Math.floor(outboundQueuedBytes / 160);
              const framesToSend =
                backlogFrames > 1200 ? 10 :
                backlogFrames > 800 ? 8 :
                backlogFrames > 500 ? 6 :
                backlogFrames > 300 ? 4 :
                backlogFrames > 120 ? 3 :
                1;
              sendOutboundFrames(framesToSend);
            } catch {
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
          if (LOG_VERBOSE || LOG_TWILIO_FRAMES) console.log(`📊 Media frames: ${mediaCount}`);
        }
        if (PIPELINE_MODE === "stt_llm_tts") {
          const audioBase64 = msg.media?.payload;
          if (!audioBase64) return;
          const mulawBuffer = Buffer.from(audioBase64, "base64");
          const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
          const assistantIsReallyTalking =
            responseInProgress ||
            premiumTtsInFlight ||
            outboundQueuedBytes > 0 ||
            outboundQueue.length > 0 ||
            assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES;
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
              if (BACKCHANNEL_ENABLED && PREMIUM_TTS_ENABLED && !sttInFlight) {
                const now = nowMs();
                const canPlay = (now - lastBackchannelAt) >= BACKCHANNEL_MIN_INTERVAL_MS;
                if (canPlay) {
                  if (backchannelTimer) clearTimeout(backchannelTimer);
                  backchannelTimer = setTimeout(() => {
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
              if (pendingSpeakQueue.length > 0) {
                const toSpeak = pendingSpeakQueue.join(" ");
                pendingSpeakQueue = [];
                enqueueElevenLabsTts(toSpeak, { interrupt: false });
              }
            }
          }
        } catch {
        }
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
                        lastUserActivityMs = nowMs();
                        const txtLower = txt.toLowerCase().trim();
                        const clientConfirmsPlate = /\b(oui\s*,?\s*c'est\s*(bien|correct|la\s*bonne|pour\s*cette\s*voiture|exact|ça|c'est\s*ça))\b/i.test(txtLower) ||
                                                     /\b(c'est\s*(bien|correct|la\s*bonne|exact|ça|c'est\s*ça))\b/i.test(txtLower) ||
                                                     /\b(oui\s*,?\s*(c'est\s*)?(pour\s*)?(cette\s*)?(voiture|plaque|immatriculation))\b/i.test(txtLower) ||
                                                     /\b(exactement|parfait|correct|oui\s*je\s*confirme)\b/i.test(txtLower);
                        if (clientConfirmsPlate && (txtLower.includes("plaque") || txtLower.includes("immatric") || txtLower.includes("voiture"))) {
                          if (LOG_VERBOSE) console.log("✅ Client confirme la plaque (transcription):", txt.substring(0, 60));
                          plateSmsSendOnFinalize = false;
                          plateSmsAlreadyMentioned = true; // Marquer que la plaque a été confirmée pour éviter l'envoi de SMS
                          plateConfirmedByClient = true;   // RDV: ne pas envoyer de SMS, valider la plaque en dossier
                          if (clientInfo?.plate) {
                            enqueueIngest("user", `Plaque confirmée: ${clientInfo.plate}`);
                            console.log("📝 Plaque confirmée envoyée à l'API de finalisation:", clientInfo.plate);
                          }
                        }
                        if (goodbyeDetected && txt && txt.trim().length >= 3) {
                          const isNoiseOrError = /^(merci d'avoir regardé|thank you for watching|subscribe|like|comment|vidéo|video|youtube|channel)/i.test(txtLower) ||
                                                 txtLower.includes("ontario") || txtLower.includes("partenariat") || 
                                                 txtLower.includes("réalisée") || txtLower.includes("réalisé");
                          if (isNoiseOrError) {
                            console.log("🔇 Transcription ignorée (probablement du bruit):", txt.substring(0, 100), "- hangup continue");
                            return;
                          }
                          const saidYesForAppointment = /\b(oui|d'accord|ok|bien sûr|c'est bon|parfait|oui je veux|oui je veux bien)\b/i.test(txtLower) && 
                                                        (txtLower.includes("rendez") || txtLower.includes("rdv") || txtLower.includes("rendez-vous"));
                          const isNegativeConfirmation = !saidYesForAppointment && /\b(non\s*,?\s*du\s*tout|c'est\s*tout|plus\s*besoin|rien\s*d'autre|pas\s*d'autre|plus\s*rien)\b/i.test(txtLower);
                          if (isNegativeConfirmation) {
                            console.log("✅ Confirmation négative détectée (client n'a plus besoin d'informations):", txt.substring(0, 100), "- hangup continue");
                            return;
                          } else if (saidYesForAppointment) {
                            console.log("✅ Client dit 'oui' pour rendez-vous, annulation hangup:", txt.substring(0, 100));
                            goodbyeDetected = false;
                            if (goodbyeTimer) clearTimeout(goodbyeTimer);
                            goodbyeTimer = null;
                            return;
                          }
                          const timeSinceLastActivity = nowMs() - lastUserActivityMs;
                          const RECENT_SPEECH_THRESHOLD_MS = 2000; // 2 secondes
                          if (timeSinceLastActivity < RECENT_SPEECH_THRESHOLD_MS) {
                            console.log("🔄 Client a parlé après au revoir:", txt.substring(0, 100), "- annulation du hangup automatique");
                            goodbyeDetected = false;
                            if (goodbyeTimer) {
                              clearTimeout(goodbyeTimer);
                              goodbyeTimer = null;
                            }
                          } else {
                            console.log("🔇 Parole utilisateur trop ancienne (", Math.round(timeSinceLastActivity / 1000), "s), hangup continue:", txt.substring(0, 100));
                          }
                        }
                      }
                    } catch {
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
        }
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            try {
              const mulawBuffer = Buffer.from(audioBase64, "base64");
              const avg = avgAbsMulaw(mulawBuffer);
              const isUserSpeech = avg > TWILIO_SPEECH_THRESHOLD;
              if (isUserSpeech) twilioSpeechFrames += 1;
              else twilioSpeechFrames = Math.max(0, twilioSpeechFrames - 1);
              if (BARGE_IN_ENABLED && responseInProgress && twilioSpeechFrames >= BARGE_IN_FRAMES) {
                cancelResponseForBargeIn();
                twilioSpeechFrames = 0;
              }
              const assistantBacklogFrames = Math.floor(outboundQueuedBytes / 160);
              const assistantIsReallyTalking =
                responseInProgress ||
                premiumTtsInFlight ||
                outboundQueuedBytes > 0 ||
                outboundQueue.length > 0 ||
                assistantBacklogFrames >= INPUT_SUPPRESS_BACKLOG_FRAMES;
              const suppressInputNow = INPUT_SUPPRESS_WHILE_TALKING && assistantIsReallyTalking;
              if (suppressInputNow) {
                inputActive = false;
                inputSpeechFrames = 0;
                inputSilenceFrames = 0;
                return;
              }
              if (mediaCount <= 3) {
                console.log(`🔊 Frame ${mediaCount} audio (μ-law):`, {
                  mulawLength: mulawBuffer.length,
                  mulawFirstBytes: Array.from(mulawBuffer.slice(0, 5)),
                  hasPayload: !!audioBase64,
                  payloadLength: audioBase64.length
                });
              }
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
              const pcm24k = convertMulawToPcm24k(mulawBuffer);
              const pcm24kBuffer = Buffer.allocUnsafe(pcm24k.length * 2);
              for (let i = 0; i < pcm24k.length; i++) {
                pcm24kBuffer.writeInt16LE(pcm24k[i], i * 2);
              }
              const pcm24kBase64 = pcm24kBuffer.toString("base64");
              appendedBytes += pcm24kBuffer.length;
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
                  inputSpeechFrames = Math.max(0, inputSpeechFrames - 1);
                  inputSilenceFrames = Math.max(0, inputSilenceFrames - 1);
                }
                if (!inputActive && inputSpeechFrames >= INPUT_SPEECH_FRAMES) {
                  inputActive = true;
                  bytesSinceInputStart = 0;
                }
                if (inputActive) {
                  openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24kBase64 }));
                  bytesSinceInputStart += pcm24kBuffer.length;
                }
                if (inputActive && inputSilenceFrames >= INPUT_SILENCE_FRAMES) {
                  const now = nowMs();
                  const minCommitBytes = 4800; // 100ms @ 24kHz PCM16
                  const canCommit = (now - lastInputCommitAt) > 300;
                  if (LOCAL_COMMIT_ENABLED && canCommit && bytesSinceInputStart >= minCommitBytes) {
                    lastInputCommitAt = now;
                    openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
                    requestResponseCreate("local_vad_commit");
                  }
                  inputActive = false;
                  inputSpeechFrames = 0;
                  inputSilenceFrames = 0;
                  bytesSinceInputStart = 0;
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
          const audioBase64 = msg.media?.payload;
          if (audioBase64) {
            const mulawLen = 160;
            preOpenFrames.push({ audioBase64, mulawLen, ts: nowMs() });
            preOpenBytes += mulawLen;
            while (preOpenFrames.length > 150) {
              const dropped = preOpenFrames.shift();
              preOpenBytes = Math.max(0, preOpenBytes - (dropped?.mulawLen ?? mulawLen));
            }
          }
          if (mediaCount <= 5) {
            console.log(`⚠️ Frame ${mediaCount}: OpenAI WS pas connecté, état:`, openaiWs?.readyState);
          }
        }
      } else if (msg.event === "stop") {
        console.log("🛑 Stream stop");
        if (LOG_VERBOSE) console.log("🛑 Raison: timeout, erreur Twilio ou fin d'appel");
        if (goodbyeTimer) {
          clearTimeout(goodbyeTimer);
          goodbyeTimer = null;
        }
        if (plateConfirmedByClient) {
          plateSmsSendOnFinalize = false;
          console.log("ℹ️ À la fin de l'appel: pas d'envoi SMS plaque (client a déjà confirmé la plaque pour le RDV)");
        }
        if (plateSmsAlreadyMentioned && plateSmsSendOnFinalize) {
          console.log("ℹ️ À la fin de l'appel: pas d'envoi SMS plaque (client a confirmé la plaque existante)");
          plateSmsSendOnFinalize = false;
        }
        if (plateSmsSendOnFinalize) {
          const shouldSend = plateSmsSendOnFinalize;
          plateSmsSendOnFinalize = false;
          if (LOG_VERBOSE) console.log("📩 Demande SMS plaque (fin appel):", shouldSend); else console.log("📩 SMS plaque demandé");
          requestPlateSmsIfNeeded("send_plate_sms_on_finalize", shouldSend)
            .then((res) => {
              if (LOG_VERBOSE) console.log("📩 Résultat SMS plaque (stop):", res); else if (res?.sent) console.log("📩 SMS envoyé");
              if (res && res.sent) {
                plateSmsWaitingForReply = true;
                if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
                plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
              } else {
                console.warn("⚠️ SMS plaque non envoyé (stop):", res?.reason || "unknown");
                if (shouldSend && res?.reason === "client_has_plate") {
                  console.log("🔄 Réessai avec force=true car l'IA a proposé d'envoyer un message");
                  requestPlateSmsIfNeeded("send_plate_sms_on_finalize_forced", true)
                    .then((forceRes) => {
                      if (forceRes && forceRes.sent) {
                        console.log("✅ SMS plaque envoyé (forcé):", forceRes);
                        plateSmsWaitingForReply = true;
                        if (plateSmsPollTimer) clearInterval(plateSmsPollTimer);
                        plateSmsPollTimer = setInterval(pollPlateSmsStatus, 1200);
                      }
                    })
                    .catch((err) => {
                      console.error("❌ Erreur lors de l'envoi SMS plaque (forcé):", err);
                    });
                }              }
            })
            .catch((err) => {
              console.error("❌ Erreur lors de l'envoi SMS plaque (stop):", err);
            });
        } else {
          console.log("ℹ️ À la fin de l'appel: pas d'envoi SMS plaque supplémentaire demandé (un SMS a pu avoir été envoyé pendant l'appel si l'IA l'a proposé)");
        }
        const streamDurationMsStop = Date.now() - callStartTimeMs;
        const RECONNECT_SHORT_FRAMES = 150;
        const RECONNECT_SHORT_MS = 8000;
        const DEFERRED_MS = Number(process.env.DEFERRED_FINALIZE_FALLBACK_MS) || 20000;
        const latestStart = latestStreamStartTimeByCallSid.get(callSid);
        const newerStreamActive = typeof latestStart === "number" && latestStart > callStartTimeMs;
        if (transferFailed && (mediaCount < RECONNECT_SHORT_FRAMES || streamDurationMsStop < RECONNECT_SHORT_MS)) {
          if (newerStreamActive) {
            console.log("⏳ Pas de finalize différé (stream plus récent actif pour ce call) — Stream stop", { mediaCount, streamDurationMs: streamDurationMsStop });
          } else {
            console.log("⏳ Finalize différé (Stream stop, reconnect stream très court)", { mediaCount, streamDurationMs: streamDurationMsStop });
            const sidForTimer = callSid;
            const t = setTimeout(() => {
              deferredFinalizeTimersByCallSid.delete(sidForTimer);
              finalizeCallToAutoGuru("twilio_stop_reconnect_deferred");
            }, DEFERRED_MS);
            deferredFinalizeTimersByCallSid.set(callSid, t);
          }
          if (outboundTimer) { clearInterval(outboundTimer); outboundTimer = null; }
          if (openaiWs) { try { openaiWs.close(); } catch (_) {} }
          return;
        }
        if (transferTriggered && !transferFailed) {
          const DEFERRED_MS_TRANSFER = Number(process.env.DEFERRED_FINALIZE_FALLBACK_MS_TRANSFER) || 45000;
          console.log("⏳ Finalize différé (transfert en cours) — webhook, 2e stream, ou fallback", DEFERRED_MS_TRANSFER / 1000, "s");
          const sidForTimer = callSid;
          const streamStartTimeForTimer = callStartTimeMs;
          deferredFinalizeTimer = setTimeout(() => {
            deferredFinalizeTimer = null;
            deferredFinalizeTimersByCallSid.delete(sidForTimer);
            const latestStart = latestStreamStartTimeByCallSid.get(sidForTimer);
            if (typeof latestStart === "number" && latestStart > streamStartTimeForTimer) {
              console.log("⏳ Fallback finalize annulé (stream reconnect actif pour ce call, IA encore en appel)");
              return;
            }
            console.log("⏳ Finalize fallback (pas de 2e stream ou webhook) — envoi finalize");
            finalizeCallToAutoGuru("twilio_stop_deferred_fallback");
          }, DEFERRED_MS_TRANSFER);
          deferredFinalizeTimersByCallSid.set(callSid, deferredFinalizeTimer);
        } else {
          finalizeCallToAutoGuru("twilio_stop");
        }
        if (outboundTimer) {
          clearInterval(outboundTimer);
          outboundTimer = null;
        }
        if (openaiWs) {
          if (LOG_VERBOSE) console.log("🛑 Fermeture connexion OpenAI...");
          try {
            if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
              openaiWs.close();
            } else {
              if (LOG_VERBOSE) console.log("🛑 OpenAI WS déjà fermé (état:", openaiWs.readyState, ")");
            }
          } catch (err) {
            console.error("❌ Erreur lors de la fermeture OpenAI WS:", err);
          }
        }
      } else {
        if (LOG_VERBOSE) console.log("ℹ️ Other event:", msg.event);
      }
    } catch (err) {
      console.error("❌ Invalid message", err);
    }
  });
  ws.on("close", () => {
    console.log("🔌 Closed, frames:", mediaCount);
    if (plateConfirmedByClient) plateSmsSendOnFinalize = false;
    if (plateSmsSendOnFinalize) {
      const shouldSend = plateSmsSendOnFinalize;
      plateSmsSendOnFinalize = false;
        if (LOG_VERBOSE) console.log("📩 Demande SMS plaque (ws close):", shouldSend); else console.log("📩 SMS plaque demandé (close)");
      requestPlateSmsIfNeeded("send_plate_sms_on_finalize_ws_close", shouldSend)
        .then((res) => {
          if (LOG_VERBOSE) console.log("📩 Résultat SMS plaque (ws close):", res); else if (res?.sent) console.log("📩 SMS envoyé");
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
    const streamDurationMs = Date.now() - callStartTimeMs;
    const RECONNECT_SHORT_STREAM_FRAMES = 150;
    const RECONNECT_SHORT_STREAM_MS = 8000;
    const DEFERRED_RECONNECT_FINALIZE_MS = Number(process.env.DEFERRED_FINALIZE_FALLBACK_MS) || 20000;
    const latestStartWs = latestStreamStartTimeByCallSid.get(callSid);
    const newerStreamActiveWs = typeof latestStartWs === "number" && latestStartWs > callStartTimeMs;
    if (transferFailed && (mediaCount < RECONNECT_SHORT_STREAM_FRAMES || streamDurationMs < RECONNECT_SHORT_STREAM_MS)) {
      if (newerStreamActiveWs) {
        console.log("⏳ Pas de finalize différé (stream plus récent actif pour ce call) — ws_close", { mediaCount, streamDurationMs });
      } else {
        console.log("⏳ Finalize différé (reconnect stream très court, possible 2e connexion)", { mediaCount, streamDurationMs });
        const sidForTimer = callSid;
        const t = setTimeout(() => {
          deferredFinalizeTimersByCallSid.delete(sidForTimer);
          finalizeCallToAutoGuru("ws_close_reconnect_deferred");
        }, DEFERRED_RECONNECT_FINALIZE_MS);
        deferredFinalizeTimersByCallSid.set(callSid, t);
      }
      if (outboundTimer) { clearInterval(outboundTimer); outboundTimer = null; }
      if (openaiWs) { openaiWs.close(); }
      return;
    }
    if (transferTriggered && !transferFailed) {
      console.log("⏳ Finalize différé (ws_close, transfert en cours)");
    } else {
      if (deferredFinalizeTimer) {
        clearTimeout(deferredFinalizeTimer);
        deferredFinalizeTimersByCallSid.delete(callSid);
        deferredFinalizeTimer = null;
      }
      finalizeCallToAutoGuru("ws_close");
    }
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
  }
  setImmediate(runRestPart2);
}
