# Streaming Twilio Media Streams — STT, LLM, TTS, réponse instantanée

Ce serveur est conçu pour un **flux entièrement en streaming** avec Twilio Media Streams : parole reçue en continu, réponse générée et jouée au fur et à mesure.

## Architecture streaming

| Étape | Flux | Détail |
|--------|------|--------|
| **STT (Speech-to-Text)** | Streaming | Les frames audio Twilio (μ-law 8 kHz) sont converties en PCM 24 kHz et envoyées en continu à l’API OpenAI Realtime via `input_audio_buffer.append`. La détection de tour de parole (VAD sémantique) est gérée côté OpenAI. |
| **LLM** | Streaming | Le modèle Realtime (ex. `gpt-4o-realtime-preview`) génère la réponse en continu ; pas d’attente de phrase complète côté serveur. |
| **TTS (Text-to-Speech)** | Streaming | Selon la config : soit **audio OpenAI** streamé en `response.audio.delta` → converti en μ-law → envoyé à Twilio ; soit **ElevenLabs / Minimax / Cartesia** avec envoi du texte par **chunks** (streaming) puis lecture des chunks audio au fur et à mesure. |
| **Twilio** | Bidirectionnel | WebSocket Media Stream : réception et envoi de frames audio en continu. |

## Configuration pour tout en streaming

### 1. Pipeline Realtime (recommandé)

```bash
PIPELINE_MODE=realtime
```

En `realtime`, tout passe par l’API OpenAI Realtime : entrée audio → STT + LLM + (optionnel) sortie audio. C’est le seul mode où STT, LLM et TTS sont réellement streamés de bout en bout.

### 2. TTS : réponse la plus instantanée

**Option A — Voix OpenAI (latence minimale)**  
Pas de tour externe TTS : l’audio est streamé directement par OpenAI vers Twilio.

```bash
REALTIME_TTS_MODE=openai
PREMIUM_TTS_ENABLED=false
```

Le serveur envoie alors `output_modalities: ["text", "audio"]` à OpenAI et transmet les `response.audio.delta` à Twilio après conversion en μ-law.

**Option B — Voix ElevenLabs / Minimax / Cartesia (streaming par chunks)**  
Le texte est envoyé par morceaux au TTS pour commencer à parler avant la fin de la réponse.

```bash
REALTIME_TTS_MODE=elevenlabs   # ou minimax / cartesia
PREMIUM_TTS_ENABLED=true
PREMIUM_TTS_PROVIDER=elevenlabs
# Chunking activé par défaut pour streamer le texte vers le TTS dès que des segments sont prêts
REALTIME_ELEVEN_CHUNKING_ENABLED=true
```

Avec `REALTIME_ELEVEN_CHUNKING_ENABLED=true` (défaut), les segments de texte sont envoyés au TTS au fur et à mesure (`output_audio_transcript.delta`), ce qui réduit la latence perçue.

### 3. Format audio (déjà géré)

- **Entrée** : Twilio envoie du μ-law 8 kHz ; le serveur convertit en PCM 24 kHz pour OpenAI.
- **Sortie** : OpenAI ou le TTS premium produit du PCM ; le serveur convertit en μ-law 8 kHz pour Twilio.

Les paramètres `input_audio_format=pcm16` et `output_audio_format=pcm16` sont déjà utilisés dans l’URL de connexion à l’API Realtime.

## Résumé des variables utiles

| Variable | Rôle | Valeur pour streaming / instantané |
|----------|------|------------------------------------|
| `PIPELINE_MODE` | Choix du pipeline | `realtime` |
| `REALTIME_TTS_MODE` | Qui produit la voix | `openai` (instantané) ou `elevenlabs` / `minimax` / `cartesia` |
| `PREMIUM_TTS_ENABLED` | Activer un TTS externe | `false` pour OpenAI natif, `true` pour ElevenLabs etc. |
| `REALTIME_ELEVEN_CHUNKING_ENABLED` | Envoi du texte au TTS par chunks | `true` (défaut) pour TTS streaming avec ElevenLabs/Minimax/Cartesia |
| `INPUT_POST_TTS_GUARD_MS` | Délai (ms) après la fin du TTS pendant lequel le micro n’est pas envoyé au STT (anti-écho / bruit haut-parleur) | Défaut : **1500** si Deepgram actif, **800** sinon. En haut-parleur avec Deepgram, augmenter à 2000 si faux positifs. |
| `DEEPGRAM_ECHO_GUARD_MS` | Avec Deepgram : pendant cette durée (ms) après la fin du TTS, les transcripts d’un ou deux mots type « bonjour », « menu », « salut », « allo » sont ignorés (évite écho haut-parleur) | Défaut : **4000**. Réduire si le client dit vraiment un mot court juste après le TTS. |
| `TURN_DETECTION_EAGERNESS` | Réactivité de la détection de fin de parole | `high` (défaut) pour réponses plus rapides |
| `DEEPGRAM_API_KEY` | Clé API Deepgram (optionnel) | Clé pour activer le STT Deepgram à la place du STT Realtime |
| `USE_DEEPGRAM_STT` | Activer le STT Deepgram | `true` pour pipeline STT Deepgram → LLM → TTS (à brancher dans le code) |
| `DEEPGRAM_MODEL` | Modèle Deepgram | `nova-3` par défaut |
| `DEEPGRAM_ENDPOINTING_MS` | Silences (ms) avant speech_final | 400 par défaut (doc: 300-500 pour conversations) |
| `DEEPGRAM_UTTERANCE_END_MS` | Gap (ms) pour UtteranceEnd | 1000 par défaut (min 1000, max 5000) |
| `DEEPGRAM_MERGE_WINDOW_MS` | Fenêtre (ms) pour fusionner plusieurs finals consécutifs en une phrase | 1400 par défaut ; si 2 finals arrivent dans cette fenêtre, fusion en 1 envoi à l'IA |

## STT optionnel : Deepgram

Le module **Deepgram** est préparé pour un futur pipeline **STT Deepgram → LLM → TTS** (sans OpenAI Realtime pour le STT). Avantages : reconnaissance de qualité, réactivité, moins de tokens OpenAI, barge-in plus simple, vocabulaire personnalisé (noms, pizzas).

- **Prérequis** : `npm install` (dépendance `@deepgram/sdk`), variable d’environnement `DEEPGRAM_API_KEY`.
- **Activation** : définir `USE_DEEPGRAM_STT=true` et `DEEPGRAM_API_KEY`. Le flux est alors : audio mulaw 8 kHz → Deepgram → transcript final → `conversation.item.create` (user) + `response.create` → Realtime LLM → TTS (ElevenLabs/Minimax/Cartesia).
- **Format** : audio μ-law 8 kHz (Twilio), modèle `nova-3`, langue `fr`, `interim_results` et `smart_format` activés. Voir `deepgram-client.js` et [Live Streaming Audio](https://developers.deepgram.com/docs/live-streaming-audio).

## Minimax TTS : meilleur rendu et qualité (speech-2.8)

- **Twilio** : Media Streams impose **8 kHz μ-law** en entrée/sortie. On ne peut pas envoyer plus que 8 kHz côté appel ; la qualité perçue dépend donc du **rendu Minimax** et du **resampling** (32 kHz ou 44,1 kHz → 8 kHz).
- **Recommandations (doc Minimax + forums)** :
  - **Modèle** : `speech-2.8-hd` pour le meilleur rendu (tonalités, timbre).
  - **Émotion** : laisser le modèle choisir = ton le plus naturel. Mettre `MINIMAX_EMOTION=` (vide) ou `MINIMAX_EMOTION=auto` pour ne pas envoyer d’émotion. Sinon `fluent` ou `calm` pour un ton fluide/posé. **speech-2.8 ne supporte pas `whisper`** (ignoré côté code).
  - **Vitesse** : `MINIMAX_SPEED=1` à `1.1` (1 = rythme normal, légèrement au-dessus peut sonner plus naturel selon la voix).
  - **Langue** : `MINIMAX_LANGUAGE_BOOST=French` (défaut).
  - **Qualité source** : `MINIMAX_SAMPLE_RATE=44100` pour la meilleure qualité avant resampling (le serveur resample en 8 kHz pour Twilio). Défaut : `32000`.
- **Voix françaises (liste système)** : `French_Female_News Anchor`, `French_CasualMan`, `French_MovieLeadFemale`, `French_FemaleAnchor`, `French_MaleNarrator`, `French_Male_Speech_New`.
- **Chunking** : `REALTIME_ELEVEN_CHUNK_MAX_CHARS=360` (ou plus) pour des phrases plus longues en une seule synthèse, prosodie plus naturelle.
- **voice_modify** (pitch, intensity, timbre) n’est pas disponible avec le format PCM (uniquement MP3/WAV/FLAC en doc Minimax).

| Variable | Rôle | Recommandation qualité |
|----------|------|-------------------------|
| `MINIMAX_MODEL` | Modèle TTS | `speech-2.8-hd` |
| `MINIMAX_EMOTION` | Émotion | vide ou `auto` (naturel) ; ou `fluent` / `calm` |
| `MINIMAX_SPEED` | Vitesse | `1` à `1.1` |
| `MINIMAX_SAMPLE_RATE` | Fréquence source | `32000` (défaut) ou `44100` (meilleure qualité) |
| `MINIMAX_LANGUAGE_BOOST` | Langue | `French` |
| `REALTIME_ELEVEN_CHUNK_MAX_CHARS` | Taille max des chunks TTS | `360` ou plus |

## Mode `stt_llm_tts` (sans Realtime)

Si `PIPELINE_MODE=stt_llm_tts`, le flux n’est pas entièrement streamé : l’audio est accumulé jusqu’à un silence (VAD), puis envoyé à Whisper (STT), puis au LLM, puis au TTS. La latence est plus élevée. Pour **STT + LLM + TTS en streaming et réponse instantanée**, utiliser **`PIPELINE_MODE=realtime`**.
