/**
 * Outils restaurant pour le LLM (AutoGuru).
 * Le LLM décide quand appeler ces fonctions.
 * Le serveur exécute uniquement les outils et gère l'audio.
 */

/**
 * Vérifie la disponibilité pour une date/service.
 * @param {object} params - { date: "YYYY-MM-DD", service: "midi"|"soir", covers?: number }
 * @param {object} context - { lunchFullToday, dinnerFullToday, lunchPassedForToday, dinnerPassedForToday, today }
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

  const lines = [];

  if (service === "midi" && isToday && lunchFullToday) {
    lines.push("Midi aujourd'hui : complet.");
  } else if (service === "midi" && isToday && lunchPassedForToday) {
    lines.push("Midi aujourd'hui : heure limite dépassée, on ne prend plus de réservation pour le déjeuner.");
  } else if (service === "soir" && isToday && dinnerFullToday) {
    lines.push("Soir aujourd'hui : complet.");
  } else if (service === "soir" && isToday && dinnerPassedForToday) {
    lines.push("Soir aujourd'hui : heure limite dépassée, on ne prend plus de réservation pour ce soir.");
  } else {
    lines.push(`${service === "midi" ? "Midi" : "Soir"} le ${date} : de la place disponible.`);
    if (covers) lines.push(`Pour ${covers} personnes.`);
  }

  return lines.join(" ");
}

/**
 * Crée une demande de réservation (données pour l'ingestion/finalize).
 * Retourne une confirmation pour le LLM.
 */
export function createReservation(params) {
  const { date, service, time, covers, seating, name } = params || {};
  const missing = [];
  if (!date) missing.push("date");
  if (!service) missing.push("service (midi ou soir)");
  if (!time) missing.push("heure");
  if (!covers) missing.push("nombre de personnes");

  if (missing.length > 0) {
    return `Informations manquantes pour créer la réservation : ${missing.join(", ")}.`;
  }

  return JSON.stringify({
    status: "ok",
    message: "Demande de réservation enregistrée.",
    reservation: { date, service, time, covers, seating: seating || null, name: name || null },
  });
}

/**
 * Annule une réservation (identifier = numéro ou nom).
 */
export function cancelReservation(params) {
  const { identifier } = params || {};
  if (!identifier) {
    return "Identifiant manquant pour annuler (numéro de téléphone ou nom de la réservation).";
  }
  return "Demande d'annulation enregistrée. Le restaurant confirmera au client.";
}
