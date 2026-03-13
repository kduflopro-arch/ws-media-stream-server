#!/usr/bin/env node
/**
 * Point d'entrée RESTAURANT uniquement.
 * Le moteur conversationnel restaurant est activé côté server-core.js via RESTAURANT_CONVERSATION_ENGINE.
 * Les appels restaurant sont routés vers ce serveur.
 * Pour les garages, utiliser server.js (service Render séparé).
 */
process.env.ACCOUNT_SECTOR = "restaurant";
await import("./server-core.js");
