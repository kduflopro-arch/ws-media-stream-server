#!/usr/bin/env node
/**
 * Point d'entrée RESTAURANT uniquement.
 * Architecture : LLM pilote la conversation, serveur = transport audio + exécution tools.
 * ACCOUNT_SECTOR=restaurant charge config-restaurant et restaurant-tools.
 * Pour les garages, utiliser server.js (service Render séparé).
 */
process.env.ACCOUNT_SECTOR = "restaurant";
await import("./server-core.js");
