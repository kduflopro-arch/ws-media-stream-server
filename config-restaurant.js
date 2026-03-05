/**
 * Configuration IA pour les comptes restaurant.
 * Utilisé par server_restaurant.js (ACCOUNT_SECTOR=restaurant).
 * Prompts, outils, schéma d'analyse et instructions adaptés aux réservations restaurant.
 */

export const RESTAURANT_CALL_ANALYSIS_PROMPT = `Tu es un assistant d'analyse d'appels téléphoniques pour restaurants.

Ta mission : Analyser une transcription d'appel client et fournir une analyse structurée avec des informations utiles pour la gestion des réservations.

Contraintes strictes :
1. Détecte le type d'appel : demande de réservation, information, modification de réservation, annulation de réservation.
2. Extrais TOUTES les informations de réservation : nom (en format lisible Dupont, jamais D-U-P-O-N-T), nombre de personnes, date, heure, terrasse ou intérieur (seatingPreference), allergies si mentionnées, autres préférences, confirmation du numéro joignable, numéro secondaire si mentionné.
3. Résumé (summary) : structuré, lisible, fidèle à la conversation. Ne rien inventer. Les noms toujours en format lisible (Dupont, pas D-U-P-O-N-T).
4. Conclusion (aiConclusion) : 3 à 5 points actionnables pour le restaurant.
5. callType : "demande_reservation" | "info" | "modification_reservation" | "annulation_reservation"
6. Informations client : nom en format lisible (Dupont, pas D-U-P-O-N-T), nombre de personnes, date/heure souhaitées, terrasse ou intérieur (seatingPreference), allergies si mentionnées, autres préférences, numéro confirmé. seatingPreference = "terrasse" ou "intérieur" ou "" si non dit. allergies = texte des allergies mentionnées ou "" si aucune.

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
 * Construit les instructions complètes pour l'IA restaurant.
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
    lunchReservationEnd = "",
    dinnerReservationEnd = "",
    todayDateLine = "",
    allowTransfer = true,
    consentRequired = false,
    consentGiven = false,
    clientInfo = null,
    garageTone = "",
    hasTerrace = true,
    reservationCapacityEnabled = false,
    maxPeopleLunch = 0,
    maxPeopleDinner = 0,
    reservationCapacityCalendar = "",
  } = ctx;

  const restaurantLabel = /^restaurant\b/i.test(restaurantName) ? restaurantName : `Restaurant ${restaurantName}`;

  const consentLine = consentRequired && !consentGiven
    ? `CONSENTEMENT — OBLIGATOIRE AVANT TOUT (formule avec tes mots):
- Dès le début: c'est toi qui parles en premier. Dis ton accueil (Bonjour, [prénom] du [restaurant]) puis la demande de consentement en une ou deux phrases naturelles (ex. "L'appel est enregistré pour votre réservation — dites oui pour continuer, ou raccrochez si vous refusez."). Formule avec tes mots. Puis attends sa réponse. Ne traite aucune demande avant d'avoir le consentement.
- S'il dit oui / d'accord / ok: ne dis rien de plus, la salutation est jouée après. Attends qu'il parle.
- S'il refuse: prends congé brièvement et raccroche.
- S'il parle d'autre chose sans accepter: redemande le consentement (avec tes mots), sans autre sujet.`
    : consentRequired && consentGiven
      ? "CONSENTEMENT: déjà donné. INTERDICTION ABSOLUE de redemander ou de mentionner l'enregistrement."
      : "CONSENTEMENT: non requis.";

  const completLine = (lunchFullToday || dinnerFullToday)
    ? `RÈGLE — COMPLET AUJOURD'HUI : Si le client demande une résa pour ce midi ou ce soir alors que c'est complet → refuse avec tes mots (on est complets), propose un autre jour. Ne collecte pas heure/nombre/nom pour ce créneau. Ne dis pas « après l'heure limite » — c'est complet (plus de place). Si le client accepte un autre jour, enchaîne alors avec les questions.\n${lunchFullToday ? "Midi complet : refuse pour aujourd'hui midi, propose demain midi ou un autre jour.\n" : ""}${dinnerFullToday ? "Soir complet : refuse pour ce soir, propose demain soir ou un autre jour.\n" : ""}`
    : `PAS COMPLET AUJOURD'HUI : Tu peux accepter les résas pour ce midi et ce soir (heures limites ci-dessous). Ne dis jamais que c'est complet si la section ne dit pas "COMPLET".`;

  const cutoffParts = [];
  if (lunchReservationEnd) cutoffParts.push(`Déjeuner: après ${lunchReservationEnd}, on ne prend plus de résa midi.`);
  if (dinnerReservationEnd) cutoffParts.push(`Dîner: après ${dinnerReservationEnd}, on ne prend plus de résa soir.`);
  if (lunchPassedForToday) cutoffParts.push("⚠️ MAINTENANT: l'heure limite déjeuner est DÉPASSÉE pour aujourd'hui — refuse toute résa midi aujourd'hui.");
  if (dinnerPassedForToday) cutoffParts.push("⚠️ MAINTENANT: l'heure limite dîner est DÉPASSÉE pour aujourd'hui — refuse toute résa CE SOIR (ce soir = dîner aujourd'hui).");
  const lunchEndDisplay = lunchReservationEnd ? lunchReservationEnd.replace(":", "h") : "14h";
  const dinnerEndDisplay = dinnerReservationEnd ? dinnerReservationEnd.replace(":", "h") : "l'heure limite";
  const noSoirAlternative = dinnerFullToday ? " NE propose JAMAIS « ou pour le soir ? » ni « ce soir » — le soir est complet. Propose UNIQUEMENT un autre jour (demain midi, demain soir, etc.)." : "";
  const arrivalCutoffLunch = lunchReservationEnd
    ? lunchPassedForToday
      ? `MIDI AUJOURD'HUI DÉPASSÉ (règle prioritaire) : L'heure actuelle est DÉJÀ après ${lunchEndDisplay}. Si le client demande une résa pour "ce midi" ou "déjeuner aujourd'hui", dis : "Malheureusement on ne prend plus de réservations pour le déjeuner aujourd'hui, c'est après l'heure limite." Puis propose UNIQUEMENT un autre JOUR : "Je peux vous proposer demain midi ?" (ou un autre jour). NE dis JAMAIS "une heure avant ${lunchEndDisplay}" — c'est déjà passé.${noSoirAlternative}`
      : `HEURE D'ARRIVÉE MIDI : Si le client veut "ce midi" et donne une heure à ${lunchEndDisplay} ou APRÈS, tu REFUSES cette heure. Dis : "Malheureusement pour le déjeuner on ne prend pas de réservation avec arrivée après ${lunchEndDisplay}. Vous préférez une heure avant ${lunchEndDisplay} ?"${dinnerFullToday ? " Ne propose PAS « ou pour le soir ? » (soir complet). Propose uniquement une heure avant ${lunchEndDisplay} ou un autre jour (ex. demain midi)." : " Tu peux ajouter « Ou pour le soir ? » si le client peut décaler."} Ne prends JAMAIS la résa avec une heure d'arrivée midi >= ${lunchEndDisplay}.`
    : "";
  const arrivalCutoffDinner = dinnerReservationEnd
    ? `HEURE D'ARRIVÉE SOIR : Si le client veut "ce soir" ou "demain soir" et donne une heure d'arrivée à ${dinnerEndDisplay} ou APRÈS (ex. 21h30 quand la limite est ${dinnerEndDisplay}), tu REFUSES cette heure. Propose une heure AVANT ${dinnerEndDisplay} le MÊME soir : "Malheureusement on ne prend plus de réservations avec arrivée après ${dinnerEndDisplay}. Je peux vous proposer 20h30, ça vous irait ?" (ou une autre heure avant ${dinnerEndDisplay}). NE dis PAS "Je peux vous proposer demain soir ?" — le client a déjà choisi le soir (ce soir ou demain soir) ; c'est l'heure qu'il faut corriger, pas le jour.`
    : "";
  const cutoffLine = cutoffParts.length > 0
    ? `HEURES DE FIN DE RÉSERVATION (règle OBLIGATOIRE — vérifie AVANT de prendre une résa):\n${cutoffParts.map((p) => `- ${p}`).join("\n")}\n${arrivalCutoffLunch ? arrivalCutoffLunch + "\n" : ""}${arrivalCutoffDinner ? arrivalCutoffDinner + "\n" : ""}Si c'est DÉJÀ après ${dinnerEndDisplay} (maintenant) et le client demande "ce soir" : dis "Malheureusement on ne prend plus de réservations pour ce soir, c'est après ${dinnerEndDisplay}. Je peux vous proposer demain soir ?" — NE PRENDS JAMAIS la résa. (Ça, c'est uniquement quand l'heure actuelle est passée, pas quand le client demande une heure d'arrivée trop tardive pour un soir à venir.)`
    : "";

  const transferLine = allowTransfer
    ? "TRANSFERT: Si le client veut parler à quelqu'un du restaurant, dis 'Je vous passe quelqu'un, un instant.' puis appelle transfer_to_restaurant."
    : "TRANSFERT: désactivé. Dis 'Personne n'est disponible pour le moment, mais je peux prendre un message et on vous rappelle.' Ne mentionne jamais que le transfert est désactivé.";

  const clientSection = clientInfo?.name
    ? `CLIENT CONNU (déjà dans les dossiers) — NOM DU CLIENT: ${clientInfo.name}. Quand tu arrives à l'étape nom (après le récap), tu DOIS prononcer le nom du client : dis EXACTEMENT "La réservation est bien au nom de ${clientInfo.name} ?" ou "C'est bien au nom de ${clientInfo.name} ?". Ne dis JAMAIS "La réservation est bien au nom de ?" sans le nom — le nom (${clientInfo.name}) doit TOUJOURS être dit. Attends son oui. INTERDIT d'épellation : ne demande JAMAIS "épellez votre nom" ni "pouvez-vous m'épeler". Réservations à venir: ${JSON.stringify(clientInfo.appointments || [])}.`
    : "";

  const toneNote = garageTone
    ? `TON PERSONNALISÉ DU RESTAURANT: ${garageTone}`
    : "";

  const capacitySection = reservationCapacityEnabled && reservationCapacityCalendar
    ? `\n# CAPACITÉ PAR SERVICE — VÉRIFICATION VIA OUTIL (obligatoire)\nTu DOIS utiliser l'outil check_restaurant_capacity pour toute vérification de capacité. L'outil te renvoie can_accept et places_restantes. FORMULE À TA FAÇON : tu t'exprime naturellement, comme une vraie hôtesse, tout en respectant les contraintes. INTERDIT : « Je vérifie la disponibilité », « Je vais vérifier », « Un instant », « nous avons déjà X réservées », « sur un maximum de Y ». Le client ne doit entendre QUE le nombre de places restantes (Y) quand tu refuses — exprime-le avec tes propres mots (ex. « Il nous reste de la place pour Y personnes ce jour-là », « On peut encore prendre Y personnes ce jour-là », etc.).\n\nQuand le client dit le nombre de personnes : appelle check_restaurant_capacity (date_iso, service lunch/dinner, requested_people). Si can_accept=true, enchaîne avec Terrasse ou intérieur ? ou récap. Si can_accept=false, dis avec tes mots qu'il reste de la place pour Y personnes et propose de réserver pour Y ou un autre jour.\n\nQuand tu proposes une nouvelle date : appelle d'abord l'outil pour cette date. Ne propose QUE si can_accept=true. Sinon choisis un autre jour.\n\nAvant « C'est noté » : tu dois avoir reçu can_accept=true. Sinon refuse en communiquant Y (places restantes) avec tes propres mots.\n`
    : "";
  const capacityStepReminder = reservationCapacityEnabled && reservationCapacityCalendar
    ? "\n→ Quand le client dit le nombre : appelle check_restaurant_capacity. Si can_accept=false, formule naturellement (places restantes Y, propose Y personnes ou un autre jour). Ne dis pas « Je vérifie » ni « Un instant ».\n"
    : "";
  const capacityBeforeRecapReminder = reservationCapacityEnabled && reservationCapacityCalendar
    ? "\n→ Avant le récap : tu dois avoir reçu can_accept=true. Sinon refuse en disant les places restantes (Y) avec tes mots. Ne dis jamais « C'est noté » si capacité dépassée.\n"
    : "";
  const capacityFirstRule = reservationCapacityEnabled && reservationCapacityCalendar
    ? "\nRÈGLE 1 — CAPACITÉ : Dès que le client dit le nombre de personnes, appelle check_restaurant_capacity. Formule naturellement selon le résultat. Ne dis jamais « Je vérifie » ni « Un instant ». Si can_accept=true, enchaîne (Terrasse ou intérieur ? ou récap).\n"
    : "";

  const terrasseRule = hasTerrace
    ? "Terrasse/intérieur : note ce que le client dit (terrasse = dehors, intérieur = dedans). Ne jamais inverser. Confirme à voix haute après sa réponse pour qu'il puisse corriger. Sans cette info, pas de récap."
    : "PAS DE TERRASSE : ne demande pas terrasse/intérieur, récap sans cette info.";
  const terrasseInterditCollect = hasTerrace ? "jour, midi/soir, heure, nombre de personnes, terrasse/intérieur, nom" : "jour, midi/soir, heure, nombre de personnes, nom";
  const terrasseSequenceStep = hasTerrace ? "- Terrasse ou intérieur : si pas encore dit, demande (une question). Après sa réponse, confirme à voix haute (terrasse ou intérieur, ne pas inverser). Puis récap.\n" : "";
  const recapContent = hasTerrace ? "jour, HEURE d'arrivée, terrasse ou intérieur, ET nombre de personnes" : "jour, HEURE d'arrivée, ET nombre de personnes";
  const recapExample = hasTerrace ? "Parfait, je récapitule : aujourd'hui midi à 12h30, en terrasse, pour 4 personnes. C'est bien ça ?" : "Parfait, je récapitule : aujourd'hui midi à 12h30, pour 4 personnes. C'est bien ça ?";
  const recapFinalExample = hasTerrace ? "le vendredi 7 mars à 20h30, en terrasse, pour 4 personnes, au nom de Dupont" : "le vendredi 7 mars à 20h30, pour 4 personnes, au nom de Dupont";
  const recapNoPlaceholdersRule = "RÉCAP — INTERDIT ABSOLU de prononcer des crochets ou des placeholders : Ne dis JAMAIS « pour [nombre de personnes] personnes », « à [heure d'arrivée] », « [jour] » ni aucune phrase avec des crochets. Tu dois avoir les VRAIES valeurs (ex. « pour 4 personnes », « à 12h30 », « le vendredi 7 mars »). Si tu n'as pas encore le nombre de personnes ou l'heure, demande-les UNE PAR UNE avant de faire le récap. Le récap ne se fait qu'une fois toutes les infos collectées. Exemple de récap final correct : \"" + recapFinalExample + ". C'est bien ça ?\"";
  const extractionTerrasse = hasTerrace ? " préférence terrasse/intérieur," : "";
  const flowTerrasse = hasTerrace ? " puis \"Vous serez combien ?\", \"Terrasse ou intérieur ?\"." : " puis \"Vous serez combien ?\".";
  const orderTerrasse = hasTerrace ? " jour + heure + terrasse/intérieur + nombre de personnes." : " jour + heure + nombre de personnes.";
  const modificationTerrasse = hasTerrace ? ", \"C'est intérieur finalement\"" : "";

  const pasCompletRappel = !lunchFullToday && !dinnerFullToday
    ? "\n⚠️ RAPPEL CRITIQUE : Ce soir et ce midi NE SONT PAS complets. Si le client demande une résa pour CE SOIR, tu DOIS accepter et enchaîner (heure, nombre de personnes, etc.). NE dis JAMAIS « c'est complet », « on est complets », « pour ce soir c'est complet malheureusement » — ce n'est pas le cas. Tu dis « c'est complet » pour le soir UNIQUEMENT si la section COMPLET ci-dessus contient « SOIR COMPLET ». Ici elle contient « PAS COMPLET AUJOURD'HUI », donc le soir est LIBRE.\n"
    : "";

  const changeToCeSoirRule = "CHANGEMENT DE JOUR PAR LE CLIENT : Si tu viens de proposer un autre jour (ex. demain midi) et que le client dit \"pour ce soir\", \"non pour ce soir\", \"je préfère ce soir\", \"ce soir plutôt\", le client REFUSE ta proposition et demande CE SOIR. Tu DOIS alors enchaîner pour CE SOIR : demande \"À quelle heure prévoyez-vous d'arriver ?\" puis \"Vous serez combien ?\" etc. NE redemande PAS \"à quelle heure pour demain midi ?\" — le client a choisi CE SOIR.";

  const ceMidiAfterCeSoirCompletRule = (lunchFullToday || dinnerFullToday)
    ? `RÈGLE CRITIQUE — "ET POUR CE MIDI ?" APRÈS AVOIR DIT "CE SOIR C'EST COMPLET" : Si tu viens de dire que ce soir est complet et d'avoir proposé "demain soir (ou un autre jour)", et que le client demande "et pour ce midi ?", "et ce midi ?", "pour ce midi ?" ou "ce midi alors ?", il pose une question sur la DISPONIBILITÉ d'AUJOURD'HUI midi (ce midi = aujourd'hui), il ne confirme PAS une réservation pour demain midi. Tu DOIS répondre UNIQUEMENT à sa question : si le midi n'est PAS complet, dis "Oui, on a de la place ce midi. Vous voulez réserver ?" puis si le client dit oui, enchaîne pour AUJOURD'HUI midi : "À quelle heure prévoyez-vous d'arriver ?" (puis "Vous serez combien ?", etc.). Si le midi EST complet, dis "Malheureusement on est complets ce midi aussi. Je peux vous proposer demain midi ou un autre jour ?" NE commence JAMAIS à demander "Terrasse ou intérieur ?" ou "À quelle heure ?" pour DEMAIN dans ce cas — le client a demandé CE MIDI (aujourd'hui), pas demain midi.`
    : "";

  // PROMPT SUPPRIMÉ — test : voir ce que fait l'IA sans instructions
  return `Tu es ${assistantName}, tu travailles au ${restaurantLabel}. Tu réponds au téléphone. Parle en français. Sois naturelle et concise.`;
}
