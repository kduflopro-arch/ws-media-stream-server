/**
 * Configuration IA pour les comptes restaurant.
 * Utilisé par server_restaurant.js (ACCOUNT_SECTOR=restaurant).
 * Version 2 — state machine + prompts optimisés.
 */

// ─── Analyse post-appel ──────────────────────────────────────────────────────

export const RESTAURANT_CALL_ANALYSIS_PROMPT = `Tu es un assistant d'analyse d'appels téléphoniques pour restaurants.

Ta mission : Analyser une transcription d'appel et fournir une analyse structurée utile pour la gestion des réservations.

Règles strictes :
1. Détecte le type d'appel : demande_reservation | info | modification_reservation | annulation_reservation.
2. Extrais TOUTES les infos de réservation : nombre de personnes, date, heure, terrasse ou intérieur (seatingPreference), allergies, préférences, numéro joignable. La réservation est au numéro appelant ; ne pas exiger de nom.
3. MESSAGE AU RESTAURANT (CRITIQUE) : Si le client a mentionné anniversaire, accessibilité, régime particulier ou demande spéciale, écris cette info EXACTE dans le champ "preferences" de reservationDetails. Ne jamais l'omettre.
4. Résumé (summary) : structuré, lisible, fidèle à la conversation. Ne rien inventer. Noms en format lisible (Dupont, pas D-U-P-O-N-T).
5. Conclusion (aiConclusion) : 3 à 5 points actionnables pour le restaurant.
6. callType : "demande_reservation" | "info" | "modification_reservation" | "annulation_reservation".

Réponds en français et respecte strictement le schéma JSON fourni.`;

export const RESTAURANT_CALL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    callType: { type: "string", enum: ["demande_reservation", "info", "modification_reservation", "annulation_reservation"] },
    summary: { type: "string" },
    aiConclusion: { type: "string" },
    callOutcome: { type: "string" },
    clientInsights: {
      type: "object",
      properties: {
        gender: { type: "string", enum: ["homme", "femme", "indéterminé"] },
        genderConfidence: { type: "number" },
        genderEvidence: { type: "string" },
        ageGroup: { type: "string", enum: ["jeune", "adulte", "senior", "indéterminé"] },
        emotionalState: { type: "string", enum: ["calme", "inquiet", "stressé", "énervé", "confiant", "indéterminé"] },
        notes: { type: "string" },
        communicationStyle: { type: "string", enum: ["direct", "détaillé", "réservé", "bavard", "indéterminé"] },
        language: { type: "string" },
      },
      required: ["gender", "genderConfidence", "genderEvidence", "ageGroup", "emotionalState", "notes", "communicationStyle", "language"],
      additionalProperties: false,
    },
    reservationDetails: {
      type: "object",
      properties: {
        guests: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        seatingPreference: { type: "string" },
        allergies: { type: "string" },
        preferences: { type: "string" },
        contactNumber: { type: "string" },
        clientName: { type: "string" },
      },
      required: ["guests", "date", "time", "seatingPreference", "allergies", "preferences", "contactNumber", "clientName"],
      additionalProperties: false,
    },
  },
  required: ["callType", "summary", "aiConclusion", "callOutcome", "clientInsights", "reservationDetails"],
  additionalProperties: false,
};

// ─── Prompt principal session OpenAI Realtime ────────────────────────────────

/**
 * Construit le prompt système pour la session OpenAI Realtime.
 * Paramètre stateInstruction : instruction d'étape injectée par la state machine.
 */
export function buildRestaurantInstructions({
  restaurantName,
  assistantName = "Sandra",
  openingHoursText = "",
  menuText = "",
  lunchFullToday = false,
  dinnerFullToday = false,
  lunchPassedForToday = false,
  dinnerPassedForToday = false,
  lunchReservationEnd = "",
  dinnerReservationEnd = "",
  todayDateLine = "",
  allowTransfer = true,
  consentRequired = true,
  consentGiven = false,
  clientInfo = null,
  garageTone = "",
  hasTerrace = true,
  restaurantClosedByDaySummary = "",
  stateInstruction = "",
} = {}) {
  const name = String(restaurantName || "le restaurant").trim();
  const label = /^restaurant\b/i.test(name) ? name : `restaurant ${name}`;
  const tone = garageTone ? `Ton : ${garageTone}. ` : "";

  const availability = [];
  if (lunchFullToday) availability.push("COMPLET ce midi");
  if (dinnerFullToday) availability.push("COMPLET ce soir");
  if (lunchPassedForToday) availability.push(`réservation midi fermée (limite ${lunchReservationEnd || "dépassée"})`);
  if (dinnerPassedForToday) availability.push(`réservation soir fermée (limite ${dinnerReservationEnd || "dépassée"})`);
  const availabilityLine = availability.length ? `\nDISPONIBILITÉ: ${availability.join(", ")}.` : "";
  const fermetureLine = restaurantClosedByDaySummary ? `\nFERMETURES: ${restaurantClosedByDaySummary}` : "";
  const terraceLine = hasTerrace
    ? "\nLE RESTAURANT A: une terrasse et une salle intérieure."
    : "\nLE RESTAURANT N'A PAS de terrasse.";
  const hoursLine = openingHoursText ? `\nHORAIRES: ${openingHoursText}` : "";
  const menuLine = menuText ? `\nINFOS/MENU: ${menuText.slice(0, 500)}` : "";
  const dateLine = todayDateLine ? `\n${todayDateLine}` : "";

  const clientLine = clientInfo?.name
    ? (() => {
        const apt = (clientInfo.appointments || []).find(a => !a.en_attente_confirmation_garage);
        const aptStr = apt
          ? ` — réservation existante le ${new Date(apt.appointment_date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} à ${(apt.appointment_time || "").slice(0, 5)}`
          : "";
        return `\nCLIENT CONNU: ${clientInfo.name}${aptStr}.`;
      })()
    : "";

  const consentLine = consentRequired && !consentGiven
    ? `\nCONSENTEMENT REQUIS: Avant toute collecte, demande poliment si le client accepte que l'appel soit enregistré. En cas de refus, raccroche courtoisement.`
    : "";

  const transferLine = allowTransfer
    ? "\n- Si le client demande à parler à quelqu'un: appeler transfer_to_restaurant."
    : "\n- Le transfert n'est pas disponible. Proposer de laisser un message.";

  const stateBlock = stateInstruction
    ? `\n\n━━━ INSTRUCTION ACTIVE ━━━\n${stateInstruction}\n━━━━━━━━━━━━━━━━━━━━━━━━━`
    : "";

  return `Tu es ${assistantName}, standardiste du ${label}.
${tone}Sois chaleureux, naturel, concis. Maximum 2 phrases par réponse. Une seule question à la fois.
${dateLine}${hoursLine}${terraceLine}${fermetureLine}${availabilityLine}${menuLine}${clientLine}${consentLine}

RÈGLES:
- Ne jamais inventer d'informations.
- Pour les questions sur le menu ou les horaires: appeler get_restaurant_info.${transferLine}
- Réservation: poser UNE SEULE question à la fois, dans l'ordre: 1) nb personnes, 2) date, 3) heure, 4) terrasse/intérieur. Ne jamais grouper plusieurs questions.
- Demander allergies/messages spéciaux uniquement après avoir collecté date, heure, nombre de personnes.${stateBlock}`;
}

// ─── State machine — instructions par étape ──────────────────────────────────

/**
 * Retourne l'instruction à injecter selon l'état courant de la réservation.
 * Appelé après chaque tour client pour guider l'IA sur le prochain champ à collecter.
 *
 * @param {object} state - reservationState
 * @param {object} opts
 * @param {boolean} opts.hasTerrace
 * @returns {string}
 */
export function buildReservationStateInstruction(state, { hasTerrace = true } = {}) {
  if (!state) return "";

  switch (state.phase) {
    case "greeting":
    case "info_only":
      return "";

    case "modification":
      return "Le client souhaite MODIFIER une réservation. Recueille les nouvelles informations souhaitées (date, heure, nombre de personnes) et confirme la demande.";

    case "annulation":
      return "Le client souhaite ANNULER une réservation. Confirme la prise en compte et rassure le client.";

    case "collecting": {
      if (!state.guests) {
        return "RÉSERVATION — ÉTAPE 1: Demande UNIQUEMENT combien de personnes. Une seule question.";
      }
      if (!state.date) {
        return `RÉSERVATION — ÉTAPE 2: ${state.guests} personne(s) notée(s). Demande UNIQUEMENT la date souhaitée. Une seule question.`;
      }
      if (!state.time) {
        return `RÉSERVATION — ÉTAPE 3: ${state.guests} personne(s), le ${state.date}. Demande UNIQUEMENT l'heure ou le service (midi/déjeuner ou soir/dîner). Une seule question.`;
      }
      if (hasTerrace && !state.seating) {
        return `RÉSERVATION — ÉTAPE 4: ${state.guests} personne(s), le ${state.date} à ${state.time}. Demande UNIQUEMENT: terrasse ou en salle ? Une seule question.`;
      }
      // Tous les champs requis sont collectés → demander extras puis récapituler
      const recap = buildRecapLine(state);
      return `RÉSERVATION — COLLECTE TERMINÉE: Tous les champs sont remplis (${recap}). Demande: "Avez-vous des allergies ou quelque chose à transmettre au restaurant ?" Puis récapitule et demande confirmation.`;
    }

    case "recap": {
      const recap = buildRecapLine(state);
      return `RÉCAPITULATIF: Confirme à voix haute la réservation complète: ${recap}. Demande "C'est bien correct ?"`;
    }

    case "confirmed":
      return "RÉSERVATION ENREGISTRÉE: Informe le client que le restaurant le rappellera pour confirmer. Prends congé chaleureusement.";

    default:
      return "";
  }
}

/** Construit la ligne de récap lisible depuis l'état. */
function buildRecapLine(state) {
  return [
    state.guests ? `${state.guests} personne(s)` : null,
    state.date ? `le ${state.date}` : null,
    state.time ? `à ${state.time}` : null,
    state.seating || null,
    state.allergies ? `allergies: ${state.allergies}` : null,
    state.extras || null,
  ].filter(Boolean).join(", ");
}

// ─── Extraction de champs depuis le texte client ─────────────────────────────

/**
 * Extrait un champ de réservation depuis le texte du client.
 * Retourne la valeur extraite ou null.
 *
 * @param {"guests"|"date"|"time"|"seating"|"allergies"|"intent"} field
 * @param {string} text
 * @returns {string|null}
 */
export function extractReservationField(field, text) {
  const t = String(text || "").toLowerCase().trim();

  switch (field) {
    case "intent": {
      if (/\b(réserver|réservation|résa|table|couverts|places)\b/.test(t)) return "reservation";
      if (/\b(modifier|déplacer|changer)\s+(ma|la|une|mon)\s+(réservation|résa|table)\b/.test(t)) return "modification";
      if (/\b(annuler|annulation|supprimer)\s+(ma|la|une|mon)\s+(réservation|résa|table)\b/.test(t)) return "annulation";
      return "info";
    }

    case "guests": {
      // "4 personnes", "on sera 3", "deux personnes", "pour 6", "table de 5"
      const num = t.match(/\b(pour\s+|on\s+sera\s+|nous\s+serons\s+|table\s+de\s+|on\s+est\s+)?(\d{1,2})\s*(personnes?|couverts?|adultes?)?\b/);
      if (num) return num[2];
      const words = { "un": "1", "une": "1", "deux": "2", "trois": "3", "quatre": "4", "cinq": "5", "six": "6", "sept": "7", "huit": "8", "neuf": "9", "dix": "10", "douze": "12" };
      for (const [word, val] of Object.entries(words)) {
        if (new RegExp(`\\b(pour\\s+|on\\s+sera\\s+|nous\\s+serons\\s+)?${word}\\s*(personnes?|couverts?|adultes?)?\\b`).test(t)) return val;
      }
      return null;
    }

    case "date": {
      // "demain", "lundi", "le 15 mars", "jeudi 20"
      const days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
      const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
      if (/\bdemain\b/.test(t)) return "demain";
      if (/\baujourd'?hui\b/.test(t)) return "aujourd'hui";
      if (/\baprès[- ]?demain\b/.test(t)) return "après-demain";
      // "le 15 mars" ou "15 mars"
      const dateMatch = t.match(/\b(?:le\s+)?(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/);
      if (dateMatch) return `${dateMatch[1]} ${dateMatch[2]}`;
      // "lundi 15" ou "lundi prochain"
      for (const day of days) {
        const dayMatch = t.match(new RegExp(`\\b${day}(?:\\s+(\\d{1,2}))?(?:\\s+prochain)?\\b`));
        if (dayMatch) return dayMatch[1] ? `${day} ${dayMatch[1]}` : day;
      }
      return null;
    }

    case "time": {
      if (/\b(midi|déjeuner|lunch|le\s+midi)\b/.test(t)) return "midi";
      if (/\b(soir|dîner|diner|ce\s+soir|le\s+soir)\b/.test(t)) return "soir";
      // "12h30", "19h", "20h30", "à 12h"
      const timeMatch = t.match(/\b(?:à\s+)?(\d{1,2})h(\d{0,2})\b/);
      if (timeMatch) return timeMatch[2] ? `${timeMatch[1]}h${timeMatch[2]}` : `${timeMatch[1]}h`;
      return null;
    }

    case "seating": {
      if (/\b(terrasse|dehors|extérieur|l'extérieur|en\s+terrasse)\b/.test(t)) return "terrasse";
      if (/\b(intérieur|salle|dedans|en\s+salle|à\s+l['']intérieur)\b/.test(t)) return "intérieur";
      return null;
    }

    case "allergies": {
      if (/\b(pas\s+d[e']|aucune?|non|sans)\s*(allergie|intolérance)\b/.test(t)) return "";
      if (/\b(allergi|intoléran|lactose|gluten|noix|arachide|fruits?\s+de\s+mer|végétar|vegan)\b/.test(t)) return t.slice(0, 120);
      return null;
    }

    default:
      return null;
  }
}
