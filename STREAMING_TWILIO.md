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
| `TURN_DETECTION_EAGERNESS` | Réactivité de la détection de fin de parole | `high` (défaut) pour réponses plus rapides |

## Mode `stt_llm_tts` (sans Realtime)

Si `PIPELINE_MODE=stt_llm_tts`, le flux n’est pas entièrement streamé : l’audio est accumulé jusqu’à un silence (VAD), puis envoyé à Whisper (STT), puis au LLM, puis au TTS. La latence est plus élevée. Pour **STT + LLM + TTS en streaming et réponse instantanée**, utiliser **`PIPELINE_MODE=realtime`**.
