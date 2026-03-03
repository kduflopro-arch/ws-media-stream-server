#!/usr/bin/env node
/**
 * Point d'entrée pour le serveur WebSocket RESTAURANT.
 * Démarre le serveur avec ACCOUNT_SECTOR=restaurant pour activer la logique
 * réservations (résa, infos, modification, annulation) et le multilangue.
 *
 * Usage: node server_restaurant.js
 * Ou: ACCOUNT_SECTOR=restaurant node server.js
 */
process.env.ACCOUNT_SECTOR = "restaurant";
await import("./server.js");
