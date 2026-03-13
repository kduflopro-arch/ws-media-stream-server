/**
 * Moteur conversationnel serveur pour appels restaurant (AutoGuru).
 * Le serveur contrôle la logique ; le LLM formule uniquement les réponses.
 *
 * Intents: reservation | info_menu | info_hours | cancel_reservation | modify_reservation | transfer_to_human | unknown
 * Slots: date, service (midi|soir), time, covers, seating (terrasse|intérieur), name
 * State: phoneConfirmed, confirmed
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
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12,
};

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function detectIntent(text, state = {}) {
  const t = normalizeText(text);
  if (!t) return INTENTS.UNKNOWN;

  if (/\b(parler(?:\s+à)?|un humain|quelqu'un|la réception|l'accueil|le restaurant directement)\b/.test(t) || /\b(transfert|transférer|passer(?:\s+la\s+ligne)?)\b/.test(t)) {
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
  if (/\b(horaires|heure|ouvert|ferm[ée]|ouvrir|fermer|ce soir vous êtes ouverts)\b/.test(t) && !/\b(réserver|réservation|reservation|table)\b/.test(t)) {
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
  if (reservationInProgress && (hasAnySlot || /\b(oui|ouais|ok|d'accord|parfait|ça marche)\b/.test(t))) {
    return INTENTS.RESERVATION;
  }

  return INTENTS.UNKNOWN;
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
  const [hh] = String(time).split(":");
  const h = parseInt(hh, 10);
  if (Number.isNaN(h)) return null;
  if (h >= 18 || h < 2) return "soir";
  if (h >= 11 && h <= 14) return "midi";
  return null;
}

function parseFrenchNumber(raw) {
  if (!raw) return null;
  const t = normalizeText(raw);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NUMBER_WORDS[t] ?? null;
}

function nextOccurrence(baseDate, targetDow, forceNextWeek = false) {
  const d = new Date(baseDate);
  let diff = (targetDow - d.getDay() + 7) % 7;
  if (diff === 0 && forceNextWeek) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
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
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    slots.date = d.toISOString().slice(0, 10);
    if (/\bdemain soir\b/.test(t)) slots.service = "soir";
    if (/\bdemain midi\b/.test(t)) slots.service = "midi";
  }
  if (!slots.date && /\baprès-demain\b/.test(t)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    slots.date = d.toISOString().slice(0, 10);
  }
  const dayNames = [
    ["dimanche", 0], ["lundi", 1], ["mardi", 2], ["mercredi", 3], ["jeudi", 4], ["vendredi", 5], ["samedi", 6],
  ];
  for (const [name, dow] of dayNames) {
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

  // time
  const timeMatch = t.match(/(?:vers\s+|à\s+)?(\d{1,2})h(?:(\d{1,2}))?/i);
  if (timeMatch) {
    slots.time = normalizeTime(timeMatch[0]);
    if (!slots.service) slots.service = inferServiceFromTime(slots.time);
  }

  // covers
  const coversPatterns = [
    /(?:pour|table pour|on sera|nous serons|nous sommes|sera|serons)\s+(?:peut[- ]?être\s+)?(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)(?:\s+ou\s+(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze))?/i,
    /(\d+)\s+personnes?/i,
    /(\d+)\s+convives?/i,
    /une table pour\s+(\d+|une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)/i,
  ];
  for (const re of coversPatterns) {
    const m = t.match(re);
    if (m) {
      const first = parseFrenchNumber(m[1]);
      const second = parseFrenchNumber(m[2]);
      if (first != null) {
        slots.covers = second != null ? Math.max(first, second) : first;
        break;
      }
    }
  }

  // seating
  if (/\b(terrasse|dehors|extérieur|exterieur)\b/.test(t)) slots.seating = "terrasse";
  if (/\b(intérieur|interieur|dedans|à l'intérieur|a l'intérieur)\b/.test(t)) slots.seating = "intérieur";
  if (/\b(peu importe|comme vous voulez|pas de préférence|pas de preference|indifférent|indifferent)\b/.test(t)) slots.seating = context.hasTerrace === false ? "" : "";

  // name only if explicitly given
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
    // si le client corrige/modifie, on écrase la valeur existante
    if (intent === INTENTS.MODIFY_RESERVATION || intent === INTENTS.RESERVATION) {
      if (v !== "" || k === "seating") next[k] = v;
      continue;
    }
    if (next[k] == null || next[k] === "") next[k] = v;
  }
  return next;
}

function decideNextAction(state, intent, context = {}) {
  const missing = [];
  if (!state.date) missing.push("date");
  if (!state.service) missing.push("service");
  if (!state.time) missing.push("time");
  if (!state.covers) missing.push("covers");
  if (context.hasTerrace !== false && (state.seating === undefined || state.seating === null)) missing.push("seating");

  const nextAction = { type: "none", question: null, confirm: false, missing };

  if (intent === INTENTS.TRANSFER_TO_HUMAN) return { nextAction: { type: "transfer", question: null, confirm: false, missing }, missing };
  if (intent === INTENTS.CANCEL_RESERVATION) return { nextAction: { type: "cancel", question: "Demande les éléments pour identifier la réservation à annuler.", confirm: false, missing }, missing };
  if (intent === INTENTS.MODIFY_RESERVATION) return { nextAction: { type: "modify", question: "Demande ce qu'il faut modifier dans la réservation.", confirm: false, missing }, missing };
  if (intent === INTENTS.INFO_MENU || intent === INTENTS.INFO_HOURS) return { nextAction: { type: "info", question: null, confirm: false, missing }, missing };

  if (intent === INTENTS.RESERVATION) {
    if (missing.length === 0) return { nextAction: { type: "confirm", question: null, confirm: true, missing }, missing };
    const priority = ["date", "service", "time", "covers", ...(context.hasTerrace !== false ? ["seating"] : [])];
    const slot = priority.find((s) => missing.includes(s)) || missing[0];
    const questions = {
      date: "Demande le jour souhaité.",
      service: "Demande si c'est pour le midi ou le soir.",
      time: "Demande l'heure d'arrivée.",
      covers: "Demande le nombre de personnes.",
      seating: "Demande si c'est en terrasse ou à l'intérieur.",
    };
    return { nextAction: { type: "ask", question: questions[slot] || "Demande l'information manquante.", confirm: false, missing }, missing };
  }

  return { nextAction, missing };
}

function formatKnown(state, context = {}) {
  const known = [];
  if (state.date) known.push(`date=${state.date}`);
  if (state.service) known.push(`service=${state.service}`);
  if (state.time) known.push(`heure=${state.time}`);
  if (state.covers) known.push(`personnes=${state.covers}`);
  if (context.hasTerrace !== false && state.seating !== null && state.seating !== undefined && state.seating !== "") known.push(`placement=${state.seating}`);
  if (state.phoneConfirmed) known.push(`téléphone confirmé`);
  return known;
}

function buildInstruction(result, state, context = {}) {
  const { intent, nextAction, missing } = result;
  const known = formatKnown(state, context);
  const prefix = known.length ? `Informations connues: ${known.join(", ")}.\n` : "";

  if (intent === INTENTS.TRANSFER_TO_HUMAN) {
    return "INSTRUCTION PRIORITAIRE SERVEUR: le client veut parler à quelqu'un. Dis une seule phrase naturelle annonçant le transfert, puis appelle transfer_to_restaurant.";
  }
  if (intent === INTENTS.CANCEL_RESERVATION) {
    return `${prefix}INSTRUCTION PRIORITAIRE SERVEUR: le client veut annuler une réservation. Demande brièvement les éléments nécessaires pour identifier la réservation.`;
  }
  if (intent === INTENTS.MODIFY_RESERVATION) {
    return `${prefix}INSTRUCTION PRIORITAIRE SERVEUR: le client veut modifier une réservation. Demande très brièvement ce qu'il faut modifier.`;
  }
  if (intent === INTENTS.INFO_MENU) {
    return "INSTRUCTION PRIORITAIRE SERVEUR: le client demande des informations sur le menu. Dis 'Je vérifie ça tout de suite.', appelle get_restaurant_info, puis réponds naturellement.";
  }
  if (intent === INTENTS.INFO_HOURS) {
    return "INSTRUCTION PRIORITAIRE SERVEUR: le client demande les horaires ou informations pratiques. Dis 'Je vérifie ça tout de suite.', appelle get_restaurant_info, puis réponds naturellement.";
  }
  if (intent === INTENTS.RESERVATION) {
    if (nextAction.confirm) {
      return `${prefix}INSTRUCTION PRIORITAIRE SERVEUR: fais un récapitulatif naturel et bref de la demande. Ne repars pas au début du protocole. Termine par une confirmation chaleureuse.`;
    }
    if (nextAction.question) {
      return `${prefix}INSTRUCTION PRIORITAIRE SERVEUR: ${nextAction.question} Ne pose qu'une seule question. Ne redemande rien d'autre. Champs manquants: ${missing.join(", ") || "aucun"}.`;
    }
  }
  if (known.length) {
    return `${prefix}INSTRUCTION PRIORITAIRE SERVEUR: réponds naturellement sans relancer le protocole.`;
  }
  return null;
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
  const { nextAction, missing } = decideNextAction(updatedState, intent, { hasTerrace: currentState.hasTerrace });

  if (nextAction.confirm) updatedState.confirmed = true;
  else updatedState.confirmed = false;

  const instruction = buildInstruction({ intent, slots, nextAction, missing }, updatedState, { hasTerrace: currentState.hasTerrace });

  return {
    intent,
    slots,
    missingSlots: [...missing],
    nextAction,
    nextQuestion: nextAction.question,
    updatedState,
    instruction,
  };
}

export { handleUserMessage, detectIntent, extractSlots, decideNextAction, INTENTS, SLOTS };
