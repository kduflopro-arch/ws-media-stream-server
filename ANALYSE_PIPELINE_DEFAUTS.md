# Analyse pipeline voix / STT / Twilio (défauts identifiés)

Document de référence pour les symptômes **coupure avant fin de phrase**, **obligation de parler « formaté »**, et **qualité audio** médiocre.

## Architecture rappel

```
Téléphone → Twilio (μ-law 8 kHz) → server-core.js
  → [option] Deepgram STT → texte → OpenAI Realtime
  → ou audio μ-law → PCM 24 kHz → append OpenAI (semantic VAD + commit)
  → réponse : texte + TTS premium (Minimax / Eleven / …) ou audio OpenAI
  → PCM / μ-law → file `outboundQueue` → frames 20 ms → Twilio
```

---

## 1. Coupure avant la fin de la phrase (assistant)

### Cause A — **Barge-in sur faux positif** (critique)

- **Fichier** : `server-core.js`, traitement `msg.event === "media"` (niveau Twilio).
- **Logique** : si `avgAbsMulaw(frame) > BARGE_IN_THRESHOLD` pendant `BARGE_IN_FRAMES` (+ extra pendant TTS), purge de `outboundQueue`, abort TTS, `response.cancel`.
- **Problème** : le **micro capte l’écho du haut-parleur** pendant que l’IA parle. Le niveau μ-law moyen peut rester élevé assez longtemps pour déclencher un barge-in **alors que l’utilisateur ne parle pas** → **coupure nette** au milieu d’une phrase.
- **Correctifs appliqués** (défauts) :
  - `BARGE_IN_THRESHOLD` : **9000 → 12500**
  - `BARGE_IN_FRAMES` : **20 → 28**
  - `BARGE_IN_TTS_EXTRA_FRAMES` : **12 → 22**
- **Override** : ajuster via `.env` si le vrai barge-in devient trop dur.

### Cause B — **`lastTtsEndAt` trop tôt** (critique)

- **Avant** : `lastTtsEndAt = Date.now()` à la fin de `drainPremiumTtsQueue`, c’est-à-dire quand l’**API TTS** a fini d’**enfiler** l’audio, **pas** quand Twilio a fini de **lire** la file.
- **Effet** :
  - Garde `INPUT_POST_TTS_GUARD_MS` et logique `postTtsGuardActive` **expiraient pendant que le HP jouait encore**.
  - Le micro renvoyait de l’audio utile + écho → renforçait les **faux barge-in** et des comportements STT bizarres.
- **Correctif** : `lastTtsEndAt` est mis à jour après **transition file non vide → vide**, avec debounce `TTS_PLAYBACK_END_DEBOUNCE_MS` (défaut **160 ms**), et seulement si `!premiumTtsInFlight`, file premium vide, `!responseInProgress`.

### Cause C — **Perte de fin de file** (rare)

- Si `outboundQueuedBytes` dépasse le plafond dur, des frames **anciennes** sont supprimées (début de phrase tronqué plutôt que fin) — surtout si saturation.

---

## 2. « Je dois faire des phrases » pour être compris (utilisateur)

### Cause A — **Commit / fin de tour trop agressive**

- **LOCAL_COMMIT** + `INPUT_SILENCE_FRAMES` : un silence court déclenche `input_audio_buffer.commit` → le modèle réagit sur un **fragment** de phrase.
- **Correctif** : `INPUT_SILENCE_FRAMES` en realtime **26 → 34** (~680 ms de silence avant commit local).

### Cause B — **Semantic VAD OpenAI `eagerness`**

- Garage : **`medium` → `low`** par défaut (restaurant reste `high`) pour laisser le client **terminer** avant que le tour soit « clos » côté modèle.
- Override : `TURN_DETECTION_EAGERNESS`.

### Cause C — **Deepgram** (si activé)

- **Noise gate** `DEEPGRAM_NOISE_GATE_THRESHOLD` : audio trop faible → remplacé par du silence → **mots étouffés** perdus.
- **Echo guard** après TTS : mots courts filtrés après `lastTtsEndAt` — avec l’ancien `lastTtsEndAt`, fenêtre mal alignée ; le nouveau timing aide.

### Cause D — **Suppression micro pendant TTS**

- `INPUT_SUPPRESS_WHILE_TALKING` + `postTtsGuardActive` : si l’utilisateur parle **trop bas** par rapport à `INPUT_SUPPRESS_BYPASS_THRESHOLD`, l’audio n’est pas envoyé.
- **Garde post-TTS** : `INPUT_POST_TTS_GUARD_MS` **600/650 → 750/850** ms pour laisser l’écho retomber **sans** rouvrir le micro trop tôt (cohérent avec `lastTtsEndAt` réel).

### Cause E — **Contenu métier**

- Prompts longs, règles RDV/consentement : le modèle peut **ignorer** des formulations ambiguës ; ce n’est pas que du signal audio.

---

## 3. Qualité audio « merdique »

### Limites externes

- **PSTN + Twilio** : **8 kHz μ-law** = plafond physique (pas du wideband).

### Côté code

- **Résampling 24 kHz → 8 kHz** (moyenne par 3) : simple, pas optimal (repli spectral) — piste d’amélioration future (filtre + resampling).
- **`voice-audio-chain.js`** : normalisation **par bloc** peut faire **pomper** le gain ; défauts un peu **adoucis** (`normAlpha`, `presence`).
- **TTS** : qualité dépend surtout du **fournisseur**, du **débit d’échantillonnage** amont (ex. Minimax 44,1 kHz avant downsample), et des **réglages voix** (`.env`).

### Pistes sans changer de transport

- Tester **`VOICE_CHAIN_ENABLED=false`** pour isoler si la chaîne dégrade.
- Ajuster **`OUTPUT_GAIN`**, voix / modèle TTS, `OPENAI_REALTIME_*` si audio OpenAI.

---

## Variables d’environnement utiles (résumé)

| Variable | Rôle |
|----------|------|
| `BARGE_IN_THRESHOLD` | Plus haut = moins de faux barge-in |
| `BARGE_IN_FRAMES`, `BARGE_IN_TTS_EXTRA_FRAMES` | Durée de parole Twilio requise |
| `INPUT_SILENCE_FRAMES` | Silence avant commit local |
| `TURN_DETECTION_EAGERNESS` | `low` / `medium` / `high` (fin de tour utilisateur) |
| `INPUT_POST_TTS_GUARD_MS` | Délai après fin **lecture** (aligné avec nouveau `lastTtsEndAt`) |
| `TTS_PLAYBACK_END_DEBOUNCE_MS` | Debounce fin de lecture Twilio |
| `DEEPGRAM_NOISE_GATE_THRESHOLD` | Seuil d’envoi audio à Deepgram |
| `VOICE_CHAIN_ENABLED` | Activer / désactiver la chaîne DSP sortante |

---

## Déploiement

Après `git pull` sur le serveur : `pm2 restart ws-server-kd --update-env`.
