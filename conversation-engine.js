/**
 * Moteur conversationnel serveur pour appels restaurant (AutoGuru).
 * Le serveur contrôle la logique ; le LLM formule uniquement les réponses.
 *
 * Intents: reservation | info_menu | info_hours | cancel_reservation | modify_reservation | transfer_to_human | unknown
 * Slots: date, service (midi|soir), time, covers, seating (terrasse|intérieur), name
 * State: phoneConfirmed, confirmed
 *
 * Exemples: "demain soir à 21h pour 4", "une table pour deux", "ce soir vers 20h", "on sera peut-être 5"
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

/**
 * Détecte l'intention principale du client.
 */
function detectIntent(text) {
  if (!text || typeof text !== "string") return INTENTS.UNKNOWN;
  const t = text.toLowerCase().trim().replace(/\s+/g, " ");

  if (
    /\b(parler|parler à|quelqu'un|un humain|réception|accueil)\b/.test(t) ||
    /\b(transfert|transférer|passer|passer la ligne)\b/.test(t)
  ) {
    return INTENTS.TRANSFER_TO_HUMAN;
  }
  if (
    /\b(annuler|annulation)\s+(ma\s+|ma\s+)?(réservation|resa|table)\b/.test(t) ||
    /\bannuler\b.*\b(réservation|resa|table)\b/.test(t) ||
    /\bplus besoin\b.*\b(réservation|table)\b/.test(t)
  ) {
    return INTENTS.CANCEL_RESERVATION;
  }
  if (
    /\b(modifier|changer|déplacer|reporter|décaler)\s+(ma\s+|ma\s+)?(réservation|resa|table)\b/.test(t) ||
    /\b(modifier|changer)\b.*\b(réservation|resa|table)\b/.test(t)
  ) {
    return INTENTS.MODIFY_RESERVATION;
  }
  if (
    /\b(menu|carte|plats|manger|cuisine)\b/.test(t) &&
    !/\b(réserver|réservation|table)\b/.test(t)
  ) {
    return INTENTS.INFO_MENU;
  }
  if (
    /\b(horaires|heures?|ouvert|fermé|ouvrir|fermer)\b/.test(t) &&
    !/\b(réserver|réservation|table)\b/.test(t)
  ) {
    return INTENTS.INFO_HOURS;
  }
  if (
    /\b(réserver|réservation|resa|table)\b/.test(t) ||
    /\b(je\s+)?(voudrais|veux|aimerais|souhaite)\s+(réserver|une table|réserver une table)\b/.test(t) ||
    /\b(prendre|avoir)\s+(une?\s+)?(table|réservation)\b/.test(t) ||
    /\b(une?\s+)?table\s+(pour|ce soir|demain)\b/.test(t)
  ) {
    return INTENTS.RESERVATION;
  }
  return INTENTS.UNKNOWN;
}

/**
 * Normalise une heure "21h", "20h30", "vers 20h" → "20:00" ou "21:00", "20:30"
 */
function normalizeTime(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})h(\d{0,2})?/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Extrait les slots (date, service, time, covers, seating, name) du texte.
 * Comprend : "demain soir", "ce soir", "samedi prochain", "vers 20h30", "pour 4", "3 ou 4", "en terrasse", etc.
 */
function extractSlots(text, context = {}) {
  const slots = { date: null, service: null, time: null, covers: null, seating: null, name: null };
  if (!text || typeof text !== "string") return slots;
  const t = text.toLowerCase().trim().replace(/\s+/g, " ");
  const today = context.today ? new Date(context.today) : new Date();

  // --- DATE ---
  if (/\baujourd'hui\b|ce soir|ce midi/.test(t)) {
    const d = today.toISOString().slice(0, 10);
    slots.date = d;
    if (/\bce soir\b/.test(t)) slots.service = "soir";
    if (/\bce midi\b/.test(t)) slots.service = "midi";
  }
  if (/\bdemain\b/.test(t) && !slots.date) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    slots.date = d.toISOString().slice(0, 10);
    if (/\bdemain\s+soir\b/.test(t)) slots.service = "soir";
    if (/\bdemain\s+midi\b/.test(t)) slots.service = "midi";
  }
  if (/\baprès-demain\b/.test(t) && !slots.date) {
    const d = new Date(today);
    d.setDate(d.getDate() + 2);
    slots.date = d.toISOString().slice(0, 10);
  }
  const dayNames = [
    { re: /\bdimanche\b/, add: 0 },
    { re: /\blundi\b/, add: 1 },
    { re: /\bmardi\b/, add: 2 },
    { re: /\bmercredi\b/, add: 3 },
    { re: /\bjeudi\b/, add: 4 },
    { re: /\bvendredi\b/, add: 5 },
    { re: /\bsamedi\b/, add: 6 },
  ];
  const todayDow = today.getDay();
  for (const { re, add } of dayNames) {
    if (re.test(t) && !slots.date) {
      let diff = (add - todayDow + 7) % 7;
      if (/\bprochain\b|semaine\s+prochaine/.test(t) && diff === 0) diff = 7;
      if (diff === 0 && !/\bprochain\b/.test(t)) diff = 0;
      const d = new Date(today);
      d.setDate(d.getDate() + diff);
      slots.date = d.toISOString().slice(0, 10);
      break;
    }
  }
  const dateMatch = t.match(/\b(le\s+)?(\d{1,2})[\s\/\-](\d{1,2})[\s\/\-]?(\d{2,4})?/);
  if (dateMatch && !slots.date) {
    const [, , day, month, year] = dateMatch;
    const y = year ? (year.length === 2 ? `20${year}` : year) : today.getFullYear();
    slots.date = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // --- SERVICE (midi/soir) ---
  if (!slots.service) {
    if (/\b(midi|déjeuner)\b/.test(t)) slots.service = "midi";
    if (/\b(soir|dîner|diner)\b/.test(t)) slots.service = "soir";
  }
  const timeMatch = t.match(/(\d{1,2})h(\d{0,2})/i);
  if (timeMatch && !slots.service) {
    const h = parseInt(timeMatch[1], 10);
    if (h >= 18 || h < 2) slots.service = "soir";
    if (h >= 11 && h <= 14) slots.service = "midi";
  }

  // --- TIME ---
  const timeRaw = t.match(/(?:vers\s+|à\s+)?(\d{1,2})h(\d{0,2})?/i);
  if (timeRaw) {
    slots.time = normalizeTime(timeRaw[0]);
  }

  // --- COVERS ---
  const coversMatch = t.match(/(?:pour|on sera|nous serons|serons|sera|table pour)\s+(\d+)(?:\s+ou\s+(\d+))?/i)
    || t.match(/(?:pour|table pour)\s+(deux|trois|quatre|cinq|six|sept|huit|neuf|dix)/i)
    || t.match(/(\d+)\s+personnes?/i)
    || t.match(/(\d+)\s+convives?/i)
    || t.match(/nous\s+sommes\s+(\d+)/i)
    || t.match(/(?:sera|serons)\s+(?:peut-être\s+)?(\d+)/i)
    || t.match(/^\s*(\d+)\s*$/);
  const numWords = { deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
  if (coversMatch) {
    let a = parseInt(coversMatch[1], 10);
    if (isNaN(a) && coversMatch[1]) a = numWords[coversMatch[1].toLowerCase()] ?? parseInt(coversMatch[1], 10);
    const b = coversMatch[2] ? (parseInt(coversMatch[2], 10) || numWords[coversMatch[2]?.toLowerCase()]) : a;
    if (!isNaN(a)) slots.covers = typeof b === "number" ? Math.max(a, b) : a;
  }

  // --- SEATING ---
  if (/\b(terrasse|dehors|extérieur)\b/.test(t)) slots.seating = "terrasse";
  if (/\b(intérieur|dedans|à l'intérieur)\b/.test(t)) slots.seating = "intérieur";
  if (/\b(peu importe|égal|pas de préférence)\b/.test(t)) slots.seating = "";

  // --- NAME ---
  const nameMatch = t.match(/(?:au nom de|nom|nom de famille|m[eo]|c'est)\s+([A-Za-zÀ-ÿ\-\s]{2,40})/i)
    || t.match(/^([A-Za-zÀ-ÿ\-]+(?:\s+[A-Za-zÀ-ÿ\-]+)*)\s*$/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name.length >= 2 && !/^\d+$/.test(name)) slots.name = name;
  }

  return slots;
}

/**
 * Fusionne les slots extraits dans l'état existant (sans écraser les valeurs déjà présentes).
 */
function mergeSlotsIntoState(state, extractedSlots) {
  const next = { ...state };
  for (const k of SLOTS) {
    const v = extractedSlots[k];
    if (v != null && v !== "" && v !== undefined) {
      if (next[k] == null || next[k] === "") next[k] = v;
    }
  }
  return next;
}

/**
 * Détermine quelle information manque et quelle action faire.
 */
function decideNextAction(state, intent) {
  const missing = [];
  if (!state.date) missing.push("date");
  if (!state.service) missing.push("service");
  if (!state.time) missing.push("time");
  if (!state.covers) missing.push("covers");
  if (state.seating === undefined || state.seating === null) missing.push("seating");
  // Nom non requis pour restaurant (réservation au numéro)

  const nextAction = { type: "none", question: null, confirm: false };
  const infoLabels = {
    date: "le jour",
    service: "le service (midi ou soir)",
    time: "l'heure d'arrivée",
    covers: "le nombre de personnes",
    seating: "terrasse ou intérieur",
    name: "le nom",
  };

  if (intent === INTENTS.TRANSFER_TO_HUMAN) {
    nextAction.type = "transfer";
    nextAction.question = null;
    return { nextAction, missing };
  }
  if (intent === INTENTS.CANCEL_RESERVATION) {
    nextAction.type = "cancel";
    nextAction.question = "À quel nom ?";
    return { nextAction, missing };
  }
  if (intent === INTENTS.MODIFY_RESERVATION) {
    nextAction.type = "modify";
    nextAction.question = "À quel nom la réservation ?";
    return { nextAction, missing };
  }
  if (intent === INTENTS.INFO_MENU || intent === INTENTS.INFO_HOURS) {
    nextAction.type = "info";
    nextAction.question = null;
    return { nextAction, missing };
  }
  if (intent === INTENTS.RESERVATION) {
    if (missing.length === 0) {
      nextAction.type = "confirm";
      nextAction.confirm = true;
      return { nextAction, missing };
    }
    const priorityOrder = ["date", "service", "time", "covers", "seating", "name"];
    for (const slot of priorityOrder) {
      if (missing.includes(slot)) {
        nextAction.type = "ask";
        if (slot === "date") nextAction.question = "Pour quel jour ?";
        else if (slot === "service") nextAction.question = "Plutôt pour le midi ou le soir ?";
        else if (slot === "time") nextAction.question = "À quelle heure prévoyez-vous d'arriver ?";
        else if (slot === "covers") nextAction.question = "Vous serez combien ?";
        else if (slot === "seating") nextAction.question = "Terrasse ou intérieur ?";
        else if (slot === "name") nextAction.question = "À quel nom ?";
        break;
      }
    }
    return { nextAction, missing };
  }

  nextAction.type = "none";
  return { nextAction, missing };
}

/**
 * Construit l'instruction à injecter au LLM.
 */
function buildInstruction(result, state) {
  const { intent, nextAction, missing } = result;
  const lines = [];
  lines.push("[INSTRUCTION SERVEUR — Le client vient de parler. Tu formules UNIQUEMENT une réponse naturelle et courte en suivant ces consignes.]");
  lines.push("");

  if (intent === "transfer_to_human") {
    lines.push("Le client souhaite parler à quelqu'un. Dis que tu le transfère et transfère l'appel.");
    return lines.join("\n");
  }
  if (intent === "cancel_reservation") {
    lines.push("Le client souhaite annuler sa réservation. Demande à quel nom.");
    return lines.join("\n");
  }
  if (intent === "modify_reservation") {
    lines.push("Le client souhaite modifier sa réservation. Demande à quel nom.");
    return lines.join("\n");
  }
  if (intent === "info_menu") {
    lines.push("Le client demande des informations sur le menu. Utilise get_restaurant_info pour répondre.");
    return lines.join("\n");
  }
  if (intent === "info_hours") {
    lines.push("Le client demande les horaires. Utilise get_restaurant_info pour répondre.");
    return lines.join("\n");
  }
  if (intent === "reservation") {
    const known = [];
    if (state.date) known.push(`date = ${state.date}`);
    if (state.service) known.push(`service = ${state.service}`);
    if (state.time) known.push(`heure = ${state.time}`);
    if (state.covers) known.push(`personnes = ${state.covers}`);
    if (state.seating) known.push(`terrasse/intérieur = ${state.seating}`);
    if (state.phoneConfirmed) known.push(`téléphone confirmé`);

    if (nextAction.confirm) {
      lines.push("Toutes les informations sont collectées. Fais un récapitulatif naturel puis confirme la réservation.");
      if (known.length) lines.push("Infos:", known.join(", "));
    } else if (nextAction.question) {
      const slotLabel = { date: "le jour", service: "midi ou soir", time: "l'heure", covers: "le nombre de personnes", seating: "terrasse ou intérieur", name: "le nom" }[missing[0]] || missing[0];
      lines.push(`Demande ${slotLabel}. ${nextAction.question}`);
      if (known.length) lines.push("Informations connues : " + known.join(", ") + ".");
    } else {
      lines.push("Continue la collecte des informations de réservation de manière naturelle.");
      if (known.length) lines.push("Infos connues:", known.join(", "));
    }
    return lines.join("\n");
  }

  lines.push("Réponds de manière naturelle au client.");
  return lines.join("\n");
}

/**
 * Point d'entrée principal.
 * @param {string} transcript - Texte du client
 * @param {object} state - État actuel { date, service, time, covers, seating, name }
 * @param {object} context - { today: "YYYY-MM-DD" } optionnel
 * @returns {object} { intent, slots, nextAction, nextQuestion, updatedState, instruction }
 */
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
  };

  const intent = detectIntent(transcript);
  const slots = extractSlots(transcript, context);
  const updatedState = mergeSlotsIntoState(currentState, slots);
  const { nextAction, missing } = decideNextAction(updatedState, intent);

  const instruction = buildInstruction(
    { intent, slots, nextAction, missing },
    updatedState
  );

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

export {
  handleUserMessage,
  detectIntent,
  extractSlots,
  decideNextAction,
  INTENTS,
  SLOTS,
};
