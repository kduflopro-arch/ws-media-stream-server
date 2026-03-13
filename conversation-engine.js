/**
 * Moteur conversationnel serveur pour appels restaurant (AutoGuru).
 * Le serveur décide de la logique du tour; le LLM ne fait que formuler.
 */

const INTENTS = {
  RESERVATION: "reservation",
  INFO_MENU: "info_menu",
  INFO_HOURS: "info_hours",
  CANCEL_RESERVATION: "cancel_reservation",
  MODIFY_RESERVATION: "modify_reservation",
  TRANSFER_TO_HUMAN: "transfer_to_human",
  UNKNOWN: "unknown",
};

const SLOTS = ["date", "service", "time", "covers", "seating", "name"];

const NUMBER_WORDS = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9,
  dix: 10, onze: 11, douze: 12,
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFrenchNumber(raw) {
  if (!raw) return null;
  const t = normalizeText(raw);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NUMBER_WORDS[t] ?? null;
}

function normalizeTime(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})h(?:(\d{1,2}))?/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function inferServiceFromTime(time) {
  if (!time) return null;
  const h = parseInt(String(time).split(":")[0], 10);
  if (Number.isNaN(h)) return null;
  if (h >= 18 || h < 2) return "soir";
  if (h >= 11 && h <= 14) return "midi";
  return null;
}

function nextOccurrence(baseDate, targetDow, forceNextWeek = false) {
  const d = new Date(baseDate);
  let diff = (targetDow - d.getDay() + 7) % 7;
  if (diff === 0 && forceNextWeek) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function detectIntent(text, state = {}) {
  const t = normalizeText(text);
  if (!t) return INTENTS.UNKNOWN;

  if (/\b(parler(?:\s+a)?|un humain|quelqu'un|quelqu’une|la réception|l'accueil|le restaurant directement)\b/.test(t) || /\b(transfert|transférer|passer(?:\s+la\s+ligne)?)\b/.test(t)) {
    return INTENTS.TRANSFER_TO_HUMAN;
  }
  if (/\b(annuler|annulation)\b.*\b(réservation|reservation|resa|table)\b/.test(t) || /\bplus besoin\b.*\b(table|réservation|reservation)\b/.test(t)) {
    return INTENTS.CANCEL_RESERVATION;
  }
  if (/\b(modifier|changer|déplacer|reporter|décaler)\b.*\b(réservation|reservation|resa|table)\b/.test(t)) {
    return INTENTS.MODIFY_RESERVATION;
  }
  if (/\b(menu|carte|plats?|desserts?|boissons?|vin|manger|cuisine)\b/.test(t) && !/\b(réserver|réservation|reservation|table)\b/.test(t)) {
    return INTENTS.INFO_MENU;
  }
  if (/\b(horaires|heure|ouvert|ferm[ée]|ouvrir|fermer)\b/.test(t) && !/\b(réserver|réservation|reservation|table)\b/.test(t)) {
    return INTENTS.INFO_HOURS;
  }
  if (
    /\b(réserver|réservation|reservation|resa|table)\b/.test(t) ||
    /\b(voudrais|veux|aimerais|souhaite)\b.*\b(réserver|une table)\b/.test(t) ||
    /\b(une )?table\b.*\b(pour|ce soir|demain|samedi|midi|soir)\b/.test(t)
  ) {
    return INTENTS.RESERVATION;
  }

  const extracted = extractSlots(t, { today: state?.today || undefined, hasTerrace: state?.hasTerrace });
  const hasAnySlot = Object.values(extracted).some((v) => v !== null && v !== undefined && v !== "");
  const reservationInProgress = !!(state?.date || state?.service || state?.time || state?.covers || state?.seating);
  if (reservationInProgress && (hasAnySlot || /\b(oui|ouais|ok|d'accord|parfait|ça marche|ca marche)\b/.test(t))) {
    return INTENTS.RESERVATION;
  }

  return INTENTS.UNKNOWN;
}

function extractSlots(text, context = {}) {
  const slots = { date: null, service: null, time: null, covers: null, seating: null, name: null };
  const t = normalizeText(text);
  if (!t) return slots;
  const today = context.today ? new Date(context.today) : new Date();

  // date
  if (/\baujourd'hui\b|\bce soir\b|\bce midi\b/.test(t)) {
    slots.date = today.toISOString().slice(0, 10);
    if (/\bce soir\b/.test(t)) slots.service = "soir";
    if (/\bce midi\b/.test(t)) slots.service = "midi";
  }
  if (!slots.date && /\bdemain\b/.test(t)) {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    slots.date = d.toISOString().slice(0, 10);
    if (/\bdemain soir\b/.test(t)) slots.service = "soir";
    if (/\bdemain midi\b/.test(t)) slots.service = "midi";
  }
  if (!slots.date && /\baprès-demain\b/.test(t)) {
    const d = new Date(today); d.setDate(d.getDate() + 2);
    slots.date = d.toISOString().slice(0, 10);
  }
  const dayNames = [["dimanche",0],["lundi",1],["mardi",2],["mercredi",3],["jeudi",4],["vendredi",5],["samedi",6]];
  for (const [name,dow] of dayNames) {
    if (!slots.date && new RegExp(`\\b${name}\\b`).test(t)) {
      const d = nextOccurrence(today, dow, /\b(prochain|semaine prochaine)\b/.test(t));
      slots.date = d.toISOString().slice(0, 10);
      break;
    }
  }
  const exactDate = t.match(/\b(?:le\s+)?(\d{1,2})[\/\-\s](\d{1,2})(?:[\/\-\s](\d{2,4}))?\b/);
  if (!slots.date && exactDate) {
    const day = parseInt(exactDate[1], 10);
    const month = parseInt(exactDate[2], 10);
    const year = exactDate[3] ? parseInt(exactDate[3].length === 2 ? `20${exactDate[3]}` : exactDate[3], 10) : today.getFullYear();
    slots.date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // service
  if (/\b(midi|déjeuner|dej)\b/.test(t)) slots.service = "midi";
  if (/\b(soir|dîner|diner)\b/.test(t)) slots.service = "soir";

  // heure
  const timeMatch = t.match(/(?:vers\s+|a\s+|à\s+)?(\d{1,2})h(?:(\d{1,2}))?/i);
  if (timeMatch) {
    slots.time = normalizeTime(timeMatch[0]);
    if (!slots.service) slots.service = inferServiceFromTime(slots.time);
  }

  // couverts
  const coversPatterns = [
    /(?:pour|table pour|on sera|nous serons|nous sommes|sera|serons)\s+(?:peut[- ]?être\s+)?(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)(?:\s+ou\s+(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze))?/i,
    /(\d+)\s+personnes?/i,
    /(\d+)\s+convives?/i,
    /une table pour\s+(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)/i,
  ];
  for (const re of coversPatterns) {
    const m = t.match(re);
    if (!m) continue;
    const first = parseFrenchNumber(m[1]);
    const second = parseFrenchNumber(m[2]);
    if (first != null) {
      slots.covers = second != null ? Math.max(first, second) : first;
      break;
    }
  }

  // placement
  if (/\b(terrasse|dehors|extérieur|exterieur)\b/.test(t)) slots.seating = "terrasse";
  if (/\b(intérieur|interieur|dedans|à l'intérieur|a l'intérieur)\b/.test(t)) slots.seating = "intérieur";

  // nom si explicitement donné
  const nameMatch = t.match(/(?:au nom de|c[' ]est au nom de|nom de)\s+([a-zà-ÿ\-\s]{2,40})/i);
  if (nameMatch) {
    const candidate = String(nameMatch[1] || "").trim();
    if (candidate && !/^\d+$/.test(candidate)) slots.name = candidate;
  }

  return slots;
}

function mergeSlotsIntoState(state, extractedSlots, intent) {
  const next = { ...state };
  for (const k of SLOTS) {
    const v = extractedSlots[k];
    if (v === undefined || v === null) continue;
    if (intent === INTENTS.MODIFY_RESERVATION || intent === INTENTS.RESERVATION) {
      if (v !== "" || k === "seating") next[k] = v;
      continue;
    }
    if (next[k] == null || next[k] === "") next[k] = v;
  }
  return next;
}

function getMissingSlots(state, context = {}) {
  const missing = [];
  if (!state.date) missing.push("date");
  if (!state.service) missing.push("service");
  if (!state.time) missing.push("time");
  if (!state.covers) missing.push("covers");
  if (context.hasTerrace !== false && (state.seating === undefined || state.seating === null)) missing.push("seating");
  return missing;
}

function decideNextAction(state, intent, context = {}) {
  const missing = getMissingSlots(state, context);
  if (intent === INTENTS.TRANSFER_TO_HUMAN) return { type: "transfer", missing };
  if (intent === INTENTS.CANCEL_RESERVATION) return { type: "cancel", missing };
  if (intent === INTENTS.MODIFY_RESERVATION) return { type: "modify", missing };
  if (intent === INTENTS.INFO_MENU) return { type: "info_menu", missing };
  if (intent === INTENTS.INFO_HOURS) return { type: "info_hours", missing };
  if (intent !== INTENTS.RESERVATION) return { type: "none", missing };
  if (missing.length === 0) return { type: "confirm", missing };
  const priority = ["date", "service", "time", "covers", ...(context.hasTerrace !== false ? ["seating"] : [])];
  const slot = priority.find((s) => missing.includes(s)) || missing[0];
  return { type: `ask_${slot}`, slot, missing };
}

function formatKnown(state, context = {}) {
  const out = [];
  if (state.date) out.push(`date=${state.date}`);
  if (state.service) out.push(`service=${state.service}`);
  if (state.time) out.push(`heure=${state.time}`);
  if (state.covers) out.push(`personnes=${state.covers}`);
  if (context.hasTerrace !== false && state.seating !== null && state.seating !== undefined && state.seating !== "") out.push(`placement=${state.seating}`);
  if (state.phoneConfirmed) out.push("téléphone confirmé");
  return out;
}

function buildTurnDirective(result, state, context = {}) {
  const known = formatKnown(state, context);
  const knownBlock = known.length ? `INFORMATIONS CONNUES: ${known.join(", ")}.` : "AUCUNE INFORMATION STRUCTURÉE FIABLE POUR LE MOMENT.";
  const missingBlock = result.missingSlots?.length ? `CHAMPS MANQUANTS: ${result.missingSlots.join(", ")}.` : "CHAMPS MANQUANTS: aucun.";

  switch (result.nextAction.type) {
    case "transfer":
      return `${knownBlock}\nACTION SERVEUR OBLIGATOIRE: annonce le transfert en une seule phrase naturelle puis appelle transfer_to_restaurant. N'ajoute aucune autre logique.`;
    case "cancel":
      return `${knownBlock}\nACTION SERVEUR OBLIGATOIRE: le client veut annuler une réservation. Demande brièvement les éléments d'identification nécessaires. Une seule question.`;
    case "modify":
      return `${knownBlock}\nACTION SERVEUR OBLIGATOIRE: le client veut modifier une réservation. Demande très brièvement ce qu'il faut modifier. Une seule question.`;
    case "info_menu":
      return `ACTION SERVEUR OBLIGATOIRE: le client demande des informations sur la carte. Dis exactement une phrase courte du type « Je vérifie ça tout de suite. », appelle get_restaurant_info, puis réponds au client avec l'information.`;
    case "info_hours":
      return `ACTION SERVEUR OBLIGATOIRE: le client demande les horaires ou une information pratique. Dis exactement une phrase courte du type « Je vérifie ça tout de suite. », appelle get_restaurant_info, puis réponds au client avec l'information.`;
    case "ask_date":
      return `${knownBlock}\n${missingBlock}\nACTION SERVEUR OBLIGATOIRE: demande uniquement le jour souhaité. Une seule question. N'ajoute rien d'autre.`;
    case "ask_service":
      return `${knownBlock}\n${missingBlock}\nACTION SERVEUR OBLIGATOIRE: demande uniquement si c'est pour le midi ou le soir. Une seule question. N'ajoute rien d'autre.`;
    case "ask_time":
      return `${knownBlock}\n${missingBlock}\nACTION SERVEUR OBLIGATOIRE: demande uniquement l'heure d'arrivée. Une seule question. N'ajoute rien d'autre.`;
    case "ask_covers":
      return `${knownBlock}\n${missingBlock}\nACTION SERVEUR OBLIGATOIRE: demande uniquement le nombre de personnes. Une seule question. N'ajoute rien d'autre.`;
    case "ask_seating":
      return `${knownBlock}\n${missingBlock}\nACTION SERVEUR OBLIGATOIRE: demande uniquement si la table est en terrasse ou à l'intérieur. Une seule question. N'ajoute rien d'autre.`;
    case "confirm":
      return `${knownBlock}\nACTION SERVEUR OBLIGATOIRE: fais un récapitulatif naturel et bref de la demande, puis termine par une formule chaleureuse de confirmation. Ne pose aucune nouvelle question. Ne repars jamais au début du protocole.`;
    default:
      return known.length ? `${knownBlock}\nACTION SERVEUR OBLIGATOIRE: réponds naturellement sans relancer de protocole ni poser de question inutile.` : null;
  }
}

function handleUserMessage(transcript, state = {}, context = {}) {
  const currentState = {
    date: state.date ?? null,
    service: state.service ?? null,
    time: state.time ?? null,
    covers: state.covers ?? null,
    seating: state.seating ?? null,
    name: state.name ?? null,
    phoneConfirmed: state.phoneConfirmed ?? false,
    confirmed: state.confirmed ?? false,
    today: context.today ?? state.today ?? null,
    hasTerrace: context.hasTerrace ?? state.hasTerrace,
  };

  const intent = detectIntent(transcript, currentState);
  const slots = extractSlots(transcript, { today: currentState.today, hasTerrace: currentState.hasTerrace });
  const updatedState = mergeSlotsIntoState(currentState, slots, intent);
  const nextAction = decideNextAction(updatedState, intent, { hasTerrace: currentState.hasTerrace });
  updatedState.confirmed = nextAction.type === "confirm";

  const instruction = buildTurnDirective({ intent, slots, nextAction, missingSlots: nextAction.missing || [] }, updatedState, { hasTerrace: currentState.hasTerrace });

  return {
    intent,
    slots,
    missingSlots: [...(nextAction.missing || [])],
    nextAction,
    nextQuestion: nextAction.type.startsWith("ask_") ? nextAction.type.replace("ask_", "") : null,
    updatedState,
    instruction,
  };
}

export { handleUserMessage, detectIntent, extractSlots, decideNextAction, INTENTS, SLOTS };
