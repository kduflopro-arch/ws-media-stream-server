/**
 * Outils restaurant pour le LLM (AutoGuru).
 * Le LLM décide quand les appeler. Le serveur les exécute.
 * Aucune logique conversationnelle ici.
 */

/**
 * Vérifie la disponibilité pour une date/service.
 * @param {object} params - { date: "YYYY-MM-DD", service: "midi"|"soir", covers?: number }
 * @param {object} context - { lunchFullToday, dinnerFullToday, lunchPassedForToday, dinnerPassedForToday, today }
 * @returns {string} "disponible" ou "complet" + texte pour le LLM
 */
export function checkAvailability(params, context = {}) {
  const { date, service, covers } = params || {};
  const {
    lunchFullToday = false,
    dinnerFullToday = false,
    lunchPassedForToday = false,
    dinnerPassedForToday = false,
    today,
  } = context;

  const todayStr = today ? new Date(today).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const isToday = date === todayStr;

  if (!date || !service) {
    return "Date et service (midi ou soir) requis pour vérifier la disponibilité.";
  }

  if (service === "midi" && isToday && lunchFullToday) return "Midi aujourd'hui : complet.";
  if (service === "midi" && isToday && lunchPassedForToday) return "Midi aujourd'hui : heure limite dépassée.";
  if (service === "soir" && isToday && dinnerFullToday) return "Soir aujourd'hui : complet.";
  if (service === "soir" && isToday && dinnerPassedForToday) return "Soir aujourd'hui : heure limite dépassée.";

  let msg = `${service === "midi" ? "Midi" : "Soir"} le ${date} : de la place disponible.`;
  if (covers) msg += ` Pour ${covers} personnes.`;
  return msg;
}

/**
 * Crée une demande de réservation. Données pour l'ingestion/run-analysis via la transcription.
 * @param {object} params - { date, service, time, covers, name?, phone? }
 * @returns {string} JSON avec status et message pour le LLM
 */
export function createReservation(params) {
  const { date, service, time, covers, seating, name, phone } = params || {};
  const missing = [];
  if (!date) missing.push("date");
  if (!service) missing.push("service (midi ou soir)");
  if (!time) missing.push("heure");
  if (!covers) missing.push("nombre de personnes");

  if (missing.length > 0) {
    return `Informations manquantes : ${missing.join(", ")}.`;
  }

  return JSON.stringify({
    status: "ok",
    message: "Demande de réservation enregistrée.",
    reservation: { date, service, time, covers, seating: seating || null, name: name || null, phone: phone || null },
  });
}

/**
 * Récupère les heures limites de réservation (midi/soir).
 * Le LLM doit appeler ce tool pour connaître les limites — ne jamais inventer.
 * @param {object} context - { lunchReservationEnd, dinnerReservationEnd }
 * @returns {string}
 */
export function getReservationLimits(context = {}) {
  const { lunchReservationEnd = "", dinnerReservationEnd = "" } = context;
  const parts = [];
  if (lunchReservationEnd) parts.push(`Déjeuner: après ${lunchReservationEnd.replace(":", "h")}, on ne prend plus de réservation midi.`);
  if (dinnerReservationEnd) parts.push(`Dîner: après ${dinnerReservationEnd.replace(":", "h")}, on ne prend plus de réservation soir.`);
  if (parts.length === 0) return "Pas d'heure limite configurée. Tu peux accepter les réservations selon les horaires d'ouverture.";
  return parts.join(" ");
}

/**
 * Annule une réservation.
 * @param {object} params - { reservation_id } ou { identifier } (numéro ou nom)
 * @returns {string} message pour le LLM
 */
export function cancelReservation(params) {
  const { reservation_id, identifier } = params || {};
  const id = reservation_id || identifier;
  if (!id) {
    return "Identifiant manquant pour annuler (reservation_id).";
  }
  return "Demande d'annulation enregistrée. Le restaurant confirmera au client.";
}
