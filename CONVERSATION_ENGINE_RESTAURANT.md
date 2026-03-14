# Architecture Restaurant — LLM pilote

## Vue d’ensemble

L’IA contrôle la conversation. Le serveur est un transport (audio + tools).

### Pipeline cible

```
Twilio audio → STT → LLM (décision + réponse) → tools serveur → TTS → Twilio
```

Le serveur ne décide plus : horaires, disponibilité, questions, flow conversation.
Le LLM décide quand appeler les outils et quelle réponse donner.

## Outils disponibles (tool calls)

| Outil | Description |
|-------|-------------|
| `get_restaurant_info` | Menu, horaires, adresse |
| `check_availability` | Vérifie disponibilité (date, service midi/soir, covers optionnel) |
| `create_reservation` | Enregistre une demande de réservation |
| `cancel_reservation` | Annule une réservation (identifier = numéro ou nom) |
| `transfer_to_restaurant` | Transfère l'appel vers un humain |

## Fichiers

| Fichier | Rôle |
|---------|------|
| `restaurant-tools.js` | Implémentation des outils : `checkAvailability`, `createReservation`, `cancelReservation` |
| `config-restaurant.js` | System prompt unique, `buildRestaurantInstructions` |
| `server-core.js` | Transport : websocket Twilio, audio, exécution des tools, TTS |

## Configuration

- Les outils sont déclarés dans `restaurantTools` (server-core.js).
- Le prompt système est fourni par `buildRestaurantInstructions` (config-restaurant.js).
- Les paramètres dynamiques (lunchFullToday, dinnerFullToday, etc.) sont passés via `startParams` ou via le contexte des outils.

## Préservation

- Twilio websocket, conversion µ-law, TTS
- Badges AutoGuru, ingestion, finalize
- SMS plaque, logs, fallback TTS
