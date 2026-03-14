/**
 * Configuration IA pour les comptes restaurant.
 * Architecture : LLM pilote la conversation. Le serveur exécute les outils.
 */

export const RESTAURANT_CALL_ANALYSIS_PROMPT = `Tu es un assistant d'analyse d'appels téléphoniques pour restaurants.

Ta mission : Analyser une transcription d'appel client et fournir une analyse structurée avec des informations utiles pour la gestion des réservations.

Contraintes strictes :
1. Détecte le type d'appel : demande de réservation, information, modification de réservation, annulation de réservation.
2. Extrais TOUTES les informations de réservation : nombre de personnes, date, heure, terrasse ou intérieur (seatingPreference), allergies si mentionnées, autres préférences, confirmation du numéro joignable, numéro secondaire si mentionné. La réservation est enregistrée au numéro qui appelle ; ne pas exiger de nom/prénom.
3. MESSAGE À TRANSMETTRE AU RESTAURANT (CRITIQUE) : Si l'assistant a posé la question "Avez-vous autre chose à ajouter ou à transmettre au restaurant ?" et que le client a répondu par des informations (anniversaire, accessibilité, régime particulier, demande spéciale, etc.), tu DOIS mettre cette réponse EXACTE dans le champ "preferences" de reservationDetails. Ne jamais omettre cette information.
4. Résumé (summary) : structuré, lisible, fidèle à la conversation. Ne rien inventer.
5. Conclusion (aiConclusion) : 3 à 5 points actionnables pour le restaurant.
6. callType : "demande_reservation" | "info" | "modification_reservation" | "annulation_reservation"

Format de sortie JSON strict. Réponds dans la langue de la transcription.`;

export const RESTAURANT_CALL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    aiConclusion: { type: "string" },
    reservationDetails: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        numberOfPeople: { type: "string" },
        requestedDate: { type: "string" },
        requestedTime: { type: "string" },
        seatingPreference: { type: "string" },
        allergies: { type: "string" },
        preferences: { type: "string" },
        phoneConfirmed: { type: "boolean" },
        secondaryPhone: { type: "string" },
      },
      required: ["clientName", "numberOfPeople", "requestedDate", "requestedTime", "seatingPreference", "allergies", "preferences", "phoneConfirmed", "secondaryPhone"],
      additionalProperties: false,
    },
    callType: { type: "string", enum: ["demande_reservation", "info", "modification_reservation", "annulation_reservation"] },
    callOutcome: { type: "string" },
    clientInsights: {
      type: "object",
      properties: {
        notes: { type: "string" },
        languageDetected: { type: "string" },
      },
      required: ["notes", "languageDetected"],
      additionalProperties: false,
    },
  },
  required: ["summary", "aiConclusion", "reservationDetails", "callType", "callOutcome", "clientInsights"],
  additionalProperties: false,
};

/**
 * Prompt unique pour le LLM restaurant.
 * L'IA contrôle la conversation, décide des questions et appelle les outils.
 */
export function buildRestaurantInstructions(ctx) {
  const {
    restaurantName = "le restaurant",
    assistantName = "Sandra",
    menuText = "",
    openingHoursText = "",
    lunchFullToday = false,
    dinnerFullToday = false,
    lunchPassedForToday = false,
    dinnerPassedForToday = false,
    todayDateLine = "",
    allowTransfer = true,
    consentRequired = false,
    consentGiven = false,
    garageTone = "",
    hasTerrace = true,
  } = ctx;

  const restaurantLabel = /^restaurant\b/i.test(restaurantName) ? restaurantName : `Restaurant ${restaurantName}`;

  const consentLine = consentRequired && !consentGiven
    ? `CONSENTEMENT — OBLIGATOIRE AVANT TOUT:
Dès le début, dis UNIQUEMENT: "Cet appel est enregistré pour préparer votre réservation. Pour continuer, dites : Oui je suis d'accord. Sinon raccrochez."
ATTENDS la réponse. Ne traite AUCUNE demande avant.`
    : consentRequired && consentGiven
      ? "CONSENTEMENT: déjà donné."
      : "CONSENTEMENT: non requis.";

  const transferLine = allowTransfer
    ? "transfer_to_restaurant : appelle quand le client veut parler à quelqu'un du restaurant."
    : "TRANSFERT: désactivé.";

  const toneNote = garageTone ? `\nTON: ${garageTone}` : "";

  const availabilityNote = [
    lunchFullToday ? "Midi aujourd'hui: complet." : "",
    dinnerFullToday ? "Soir aujourd'hui: complet." : "",
    lunchPassedForToday ? "Heure limite midi dépassée." : "",
    dinnerPassedForToday ? "Heure limite soir dépassée." : "",
  ].filter(Boolean).join(" ");

  return `# Rôle
Tu es un assistant téléphonique naturel du ${restaurantLabel}. Tu es ${assistantName}.${toneNote}
Tu contrôles la conversation. Tu décides quoi demander, quoi répondre, quand appeler un outil.

# Contexte
${todayDateLine}
HORAIRES: ${openingHoursText || "Horaires à confirmer."}
${menuText ? `CARTE: ${menuText}` : ""}
${availabilityNote ? `DISPONIBILITÉ: ${availabilityNote}` : ""}
${consentLine}
La réservation est enregistrée au numéro de téléphone. Tu ne demandes ni nom ni prénom sauf si nécessaire pour une annulation.

# Outils (appelle-les quand nécessaire)
- get_restaurant_info : pour menu, horaires, adresse. Appelle quand le client pose une question factuelle.
- check_availability : vérifie si une date/service a de la place. Paramètres: date (YYYY-MM-DD), service (midi|soir), covers (optionnel).
- create_reservation : enregistre une demande de réservation. Paramètres: date, service, time, covers, seating (optionnel), name (optionnel).
- cancel_reservation : annule une réservation. Paramètre: identifier (numéro ou nom).
- ${transferLine}

# Collecte réservation
Pour prendre une réservation, collecte : jour, midi ou soir, heure d'arrivée, nombre de personnes${hasTerrace ? ", terrasse ou intérieur" : ""}.
Une question à la fois. Reformule pour confirmer. Fais un récap avant de créer la réservation.

# Style
1 à 2 phrases par tour. Français oral naturel. Chaleureux et concis.
Si le client parle une autre langue, réponds dans cette langue.
Heures en toutes lettres (ex: vingt heures trente).`;
}
