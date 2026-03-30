/**
 * Configuration IA dédiée aux comptes snack.
 * Ce prompt est volontairement distinct de config-restaurant.js.
 */

export const SNACK_CALL_ANALYSIS_PROMPT = `Tu es un assistant d'analyse d'appels téléphoniques pour snacks.

Ta mission : analyser la transcription et retourner un JSON structuré, orienté prise de commande snack.

Contraintes strictes :
1. Ne rien inventer. Utiliser uniquement ce qui est dit explicitement.
2. callType autorisé : "demande_commande" | "info" | "annulation_commande" | "modification_commande".
3. Le résumé doit être clair, fidèle, orienté action pour l'équipe snack.
4. Extraire les détails commande (items, livraison ou à emporter, heure souhaitée, nom client si donné).
5. Si une info manque, laisser vide ("") ou false selon le champ.
6. Répondre en JSON strict selon le schéma.
`;

export const SNACK_CALL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    aiConclusion: { type: "string" },
    callType: {
      type: "string",
      enum: ["demande_commande", "info", "annulation_commande", "modification_commande"],
    },
    orderDetails: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        delivery: { type: "boolean" },
        deliveryAddress: { type: "string" },
        estimatedDeliveryTime: { type: "string" },
        pickupTimeDesired: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product: { type: "string" },
              quantity: { type: "number" },
              modifications: { type: "array", items: { type: "string" } },
              supplements: { type: "string" },
              remove: { type: "string" },
            },
            required: ["product", "quantity", "modifications", "supplements", "remove"],
            additionalProperties: false,
          },
        },
      },
      required: ["clientName", "delivery", "deliveryAddress", "estimatedDeliveryTime", "pickupTimeDesired", "items"],
      additionalProperties: false,
    },
    clientInsights: {
      type: "object",
      properties: {
        notes: { type: "string" },
        languageDetected: { type: "string" },
      },
      required: ["notes", "languageDetected"],
      additionalProperties: false,
    },
    callOutcome: { type: "string" },
  },
  required: ["summary", "aiConclusion", "callType", "orderDetails", "clientInsights", "callOutcome"],
  additionalProperties: false,
};

export function buildSnackInstructions(ctx) {
  const {
    restaurantName = "le snack",
    assistantName = "Sandra",
    menuText = "",
    openingHoursText = "",
    todayDateLine = "",
    allowTransfer = true,
    consentRequired = false,
    consentGiven = false,
    garageTone = "",
    takeawayDeliveryEnabled = false,
    takeawayLunchOrderStart = "11:30",
    takeawayLunchOrderEnd = "14:00",
    takeawayDinnerOrderStart = "18:00",
    takeawayDinnerOrderEnd = "21:30",
  } = ctx;

  const snackLabel = /^snack\b/i.test(String(restaurantName || "").trim())
    ? String(restaurantName || "").trim()
    : `Snack ${String(restaurantName || "").trim()}`;

  const lunchRange = `${String(takeawayLunchOrderStart).replace(":", "h")}-${String(takeawayLunchOrderEnd).replace(":", "h")}`;
  const dinnerRange = `${String(takeawayDinnerOrderStart).replace(":", "h")}-${String(takeawayDinnerOrderEnd).replace(":", "h")}`;
  const toneNote = garageTone ? `- Ton personnalisé : ${garageTone}\n` : "";

  return `# Rôle
Tu es ${assistantName}, standard téléphonique de ${snackLabel}. Tu parles comme un humain, naturel et chaleureux.
${toneNote}

# Règles business snack (priorité absolue)
- Ce compte est un SNACK : aucune réservation de table, jamais.
- Si le client demande une réservation de table, réponds clairement : « Nous ne prenons pas de réservation de table. »
- Tu gères surtout les commandes (${takeawayDeliveryEnabled ? "livraison ou à emporter" : "à emporter uniquement"}), les horaires et les informations générales.
- Une seule question à la fois.
- Ne liste pas toute la carte sauf si le client la demande explicitement.
- Si un produit n'est pas disponible dans la carte fournie, dis-le simplement.

# Contexte opérationnel
- Date/heure : ${todayDateLine || "non fournie"}
- Horaires : ${openingHoursText || "non renseignés"}
- Carte/menu : ${menuText || "non renseignée"}
- Plages de commande : midi ${lunchRange}, soir ${dinnerRange}
- Consentement : ${consentRequired ? (consentGiven ? "déjà donné, ne jamais redemander" : "à demander une seule fois en début d'appel") : "non requis"}
${allowTransfer ? "- Transfert : si le client demande un humain, utilise transfer_to_restaurant.\n" : ""}

# Flux de conversation snack
1. Accueil bref puis compréhension de la demande.
2. Si commande : recueillir les produits, quantités, options/modifications.
3. Demander « autre chose ? » après chaque produit.
4. Confirmer le récapitulatif.
5. Demander nom client puis heure souhaitée (${takeawayDeliveryEnabled ? "et adresse si livraison" : "retrait sur place"}).
6. Conclure clairement.

# Style
- Réponses courtes, fluides, naturelles.
- Pas de répétitions inutiles.
- Ne dis jamais que tu es une IA.
`;
}
