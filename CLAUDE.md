# CLAUDE.md — ws-media-stream-server

Contexte de travail pour Claude Code sur ce projet.

---

## Architecture générale

Serveur WebSocket Node.js (ESM) qui gère les appels téléphoniques via Twilio Media Streams.

**Pipeline audio :**
```
Twilio (mulaw 8kHz) → Deepgram STT → OpenAI Realtime LLM → ElevenLabs TTS → Twilio
```

**Fichiers clés :**
- `server-core.js` — cœur du serveur, toute la logique d'appel
- `deepgram-client.js` — session Deepgram live STT
- `config-snack.js` — prompt + schema IA pour les comptes snack
- `config-restaurant.js` — prompt + schema IA pour les comptes restaurant

---

## Déploiement

- **Serveur** : Hetzner `root@88.198.149.117`
- **Process manager** : PM2, process nommé `ws-server-kd`
- **Config PM2** : `/opt/ws-media-stream-server/ecosystem.config.cjs`
- **Render** : instance séparée (health check `/health`)

**Commandes déploiement :**
```bash
# Sur le Mac
git add . && git commit -m "..." && git push

# Sur Hetzner
ssh root@88.198.149.117 "cd /opt/ws-media-stream-server && git pull && pm2 reload ecosystem.config.cjs --update-env"
```

---

## Variables d'environnement importantes (ecosystem.config.cjs)

| Variable | Valeur actuelle | Notes |
|---|---|---|
| `PREMIUM_TTS_PROVIDER` | `elevenlabs` | elevenlabs / inworld / cartesia / minimax |
| `ELEVENLABS_MODEL_ID` | `eleven_v3` | Modèle ElevenLabs |
| `ELEVENLABS_VOICE_ID_FEMALE` | `YxrwjAKoUKULGd0g8K9Y` | Lucie (Support Agent FR) |
| `ELEVENLABS_VOICE_ID_MALE` | `1EmYoP3UnnnwhlJKovEy` | — |
| `USE_DEEPGRAM_STT` | `true` | Active le pipeline Deepgram STT |
| `DEEPGRAM_MODEL` | `nova-3` | — |
| `DEEPGRAM_RESPONSE_DELAY_MS` | `80` | Délai après transcript avant response.create |
| `DEEPGRAM_MERGE_WINDOW_MS` | `120` | Fenêtre de fusion segments Deepgram |
| `DEEPGRAM_NOISE_GATE_THRESHOLD` | `280` | Seuil bruit ambiant (avgAbsMulaw) |
| `INWORLD_API_KEY` | `MnhNcU...` | Base64 pré-encodé |
| `INWORLD_MODEL_ID` | `inworld-tts-1.5-max` | max = plus expressif, mini = moins cher |
| `INWORLD_VOICE_ID_FEMALE` | `Hélène` | Voix FR disponibles : Hélène, Alain, Mathieu, Étienne |
| `INWORLD_VOICE_ID_MALE` | `Étienne` | — |
| `INWORLD_SPEAKING_RATE` | `1.0` | Vitesse (1.0 = défaut) |
| `INWORLD_TEMPERATURE` | `1.5` | Expressivité (1.0–2.0) |

---

## Bug connu : effectiveSector vs establishmentType

Les comptes snack ont `garageType = "restaurant"` en BDD → `effectiveSector = "restaurant"`.
Toutes les conditions snack-spécifiques doivent checker `establishmentType === "snack"` **en plus** de `effectiveSector === "snack"`.

---

## Deepgram STT — réglages appliqués

**Dans `deepgram-client.js` :**
- `encoding: "mulaw"`, `sample_rate: 8000` (Twilio natif)
- `no_delay: true` — recommandation Deepgram pour IA conversationnelle
- `endpointing: 300ms` — détection fin de phrase (téléphonie)
- `filler_words: false` — "euh"/"hmm" ignorés
- `utterance_end_ms: 1000` — gap min après dernier mot
- `smart_format: true`
- Keyterms ajoutés : jours, heures, `S`, `M`, `L`, `XL`, `XXL` (tailles snack)

**Noise gate (`server-core.js`) :**
Avant `deepgramSession.sendAudio()`, si `avg < DEEPGRAM_NOISE_GATE_THRESHOLD` (280) → envoie silence mulaw (`0xFF`). Hangover de 10 frames (~200ms) pour ne pas couper les fins de mots.

**Merge window :**
Phrase isolée → envoi immédiat à OpenAI Realtime (sans attendre MERGE_WINDOW_MS).
Segments fragmentés → fusion dans la fenêtre de 120ms.

---

## Inworld TTS — intégration

**Endpoint :** `POST https://api.inworld.ai/tts/v1/voice`
**Auth :** `Authorization: Basic <clé_déjà_base64>`

**Corps de la requête (champs camelCase — non-streaming) :**
```json
{
  "text": "...",
  "voiceId": "Hélène",
  "modelId": "inworld-tts-1.5-max",
  "temperature": 1.5,
  "audioConfig": {
    "audioEncoding": "MULAW",
    "sampleRateHertz": 8000,
    "speakingRate": 1.0
  }
}
```

⚠️ Champs snake_case (`audio_config`, `audio_encoding`, `sample_rate`) = endpoint **streaming** uniquement.
⚠️ Inworld a seulement 4 voix françaises (Alain, Hélène, Mathieu, Étienne) — toutes décrites comme "calm".

**Réponse :** `{ "audioContent": "<base64 MULAW>" }` — envoyer directement à Twilio sans conversion.

---

## ElevenLabs TTS — notes

- Les voix de la bibliothèque partagée doivent être **ajoutées au compte** avant usage API.
- Voix actuelle : `Lucie - Support Agent` (`YxrwjAKoUKULGd0g8K9Y`) — French female customer care.
- Pour tester une nouvelle voix : l'ajouter sur elevenlabs.io → Voice Library → Add to library, puis récupérer l'ID via `GET /v1/voices`.
- Modèle `eleven_v3` — le plus naturel/expressif.

---

## Prompt snack (`config-snack.js`) — règles importantes

**RÈGLE 4 / RÈGLE 5 — Variantes :**
- `(exactement N choix)` → forcer N, ni plus ni moins
- `(max N choix)` → entre 1 et N, **ne pas forcer N**, s'arrêter si N atteint
- `(entre N et M choix)` → entre N et M
- `(multi minN)` → au moins N

**Problème connu :** Les formats tacos 3-viandes/4-viandes ont `max_choices` sans `min_choices` en BDD → le générateur affiche `(max 3 choix)` au lieu de `(exactement 3 choix)`. Fix : setter `min_choices = max_choices` dans la BDD, ou accepter que `max` = "jusqu'à N".

**Schema `SNACK_CALL_ANALYSIS_SCHEMA` :** Le `required` des items doit inclure tous les champs :
```js
required: ["product", "quantity", "category_type", "bread", "size", "meats", "sauces",
           "as_menu", "formula_choice", "sto_removed", "supplements_list", "variant_choices", "modifications"]
```

---

## Bugs résolus dans cette session

| Bug | Cause | Fix |
|---|---|---|
| Grésaillement Inworld | Champs snake_case → Inworld ignorait l'encodage, renvoyait MP3 décodé comme mulaw | `audioConfig` / `audioEncoding` / `sampleRateHertz` (camelCase) |
| 3s de délai STT | `DEEPGRAM_MERGE_WINDOW_MS` 300ms ajouté à chaque utterance | Envoi immédiat si phrase isolée |
| "L" / "coca" filtrés | `isJunkTranscript` : longueur < 3 + substring matching ("merguez" → "mer") | Bypass snack + word-boundary matching |
| Retry réponse vide (Deepgram) | `lastCommitAt` jamais mis à jour (Deepgram = `conversation.item.create`, pas buffer audio) | `lastCommitAt = nowMs()` dans `sendToRealtime` |
| effectiveSector bug | Comptes snack ont `garageType="restaurant"` → `effectiveSector="restaurant"` | Toutes les guards vérifient aussi `establishmentType === "snack"` |
| Schema run-analysis | `required` array incomplet dans `SNACK_CALL_ANALYSIS_SCHEMA` | Tous les 13 champs ajoutés |
| AI demande trop de viandes | Pas de règle pour `(max N choix)` dans le prompt | RÈGLE 4 ajoutée |
| Barge-in → silence IA | `responseInProgress=false` pendant TTS externe | Check `ttsCurrentlyPlaying` + retry 450ms après response cancelled |
