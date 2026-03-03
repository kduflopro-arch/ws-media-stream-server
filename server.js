#!/usr/bin/env node
/**
 * Point d'entrée GARAGE uniquement.
 * Les appels garage sont routés vers ce serveur.
 * Pour les restaurants, utiliser server_restaurant.js (service Render séparé).
 */
process.env.ACCOUNT_SECTOR = "garage";
await import("./server-core.js");
