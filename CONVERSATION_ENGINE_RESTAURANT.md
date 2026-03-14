# Moteur conversationnel serveur — Restaurant

## Architecture

Le serveur contrôle la logique conversationnelle. Le LLM formule uniquement les réponses naturelles.

### Pipeline

1. **Transcription** : `conversation.item.input_audio_transcription.completed` → `transcript`
2. **Moteur** : `handleUserMessage(transcript, reservationState, context)` → mise à jour de l’état et instruction
3. **Commit** : `input_audio_buffer.committed` → watchdog 50 ms
4. **Injection** : si `pendingRestaurantInstruction` → `conversation.item.create` (message user avec instruction)
5. **Génération** : `response.create` → LLM produit une réponse naturelle selon l’instruction

## Variables d’état (scope WebSocket)

| Variable | Type | Description |
|----------|------|-------------|
| `reservationState` | `object` | État de la réservation en cours |
| `reservationState.date` | `string \| null` | Date ISO (YYYY-MM-DD) |
| `reservationState.service` | `string \| null` | "midi" ou "soir" |
| `reservationState.time` | `string \| null` | Heure "HH:MM" |
| `reservationState.covers` | `number \| null` | Nombre de personnes |
| `reservationState.seating` | `string \| null` | "terrasse" ou "intérieur" |
| `reservationState.name` | `string \| null` | Nom du client |
| `pendingRestaurantInstruction` | `string \| null` | Instruction à injecter avant le prochain `response.create` |

## Configuration

- `RESTAURANT_CONVERSATION_ENGINE` (env) : `"true"` ou `"false"`. Par défaut `"true"`.

## Fichiers

- **`conversation-engine.js`** : moteur (intent, slots, next action, instruction)
- **`server-core.js`** : intégration (import, variables, handler transcription, injection avant response.create)

---

## Exemple de flux conversationnel

### Client : « Bonsoir je voudrais réserver demain soir pour 4 »

**Moteur :**
- Intent : `reservation`
- Slots extraits : `{ date: "2025-03-14", service: "soir", covers: 4, time: null, seating: null, name: null }`
- État mis à jour : `{ date: "2025-03-14", service: "soir", time: null, covers: 4, seating: null, name: null }`
- Manque : `time`
- Instruction : « Le client souhaite réserver demain soir pour 4 personnes. Demande l’heure d’arrivée naturellement. Infos connues : date, service, personnes. »

**LLM (réponse attendue) :**  
« Très bien, à quelle heure prévoyez-vous d’arriver ? »

---

### Client : « À 21h »

**Moteur :**
- Slots extraits : `{ time: "21:00" }`
- État mis à jour : `{ ..., time: "21:00" }`
- Manque : `seating` (terrasse ou intérieur)
- Instruction : « Demande naturellement : Terrasse ou intérieur ? Infos connues : date, service, heure, personnes. »

**LLM :**  
« Parfait. Terrasse ou intérieur ? »

---

### Client : « En terrasse »

**Moteur :**
- Slots : `{ seating: "terrasse" }`
- État : complet
- Action : `confirm`
- Instruction : « Toutes les informations sont collectées. Fais un récapitulatif puis confirme la réservation. »

**LLM :**  
« Parfait, je récapitule : demain soir à 21h, en terrasse, pour 4 personnes. C’est noté, le restaurant vous confirmera par SMS. »
