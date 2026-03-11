# Configuration Cartesia TTS dans Render

Ce document liste les variables d'environnement Render à ajouter pour préparer l'intégration de **Cartesia** comme fournisseur TTS premium (alternative à Minimax / ElevenLabs).

## Contexte

- **Cartesia** : TTS ultra-rapide (TTFA 40–90 ms), API SSE ou WebSocket.
- **Modèle recommandé** : `sonic-3` (supporte le français et 41 autres langues).
- **Choix voix sur autoguru** : le garage/restaurant choisit entre **Homme** et **Femme** dans les paramètres IA → ce choix est transmis au serveur via `assistantVoice` ("male" | "female").

---

## Variables Render à ajouter

### Variables obligatoires

```bash
# Activer le TTS premium
PREMIUM_TTS_ENABLED=true

# Sélectionner Cartesia comme fournisseur (par défaut sur Render si clé fournie)
PREMIUM_TTS_PROVIDER=cartesia

# Clé API Cartesia (Bearer token)
CARTESIA_API_KEY=votre_clé_api_cartesia

# IDs de voix (au moins un requis)
CARTESIA_VOICE_ID=votre_voice_id_par_défaut
CARTESIA_VOICE_ID_MALE=votre_voice_id_homme
CARTESIA_VOICE_ID_FEMALE=votre_voice_id_femme

# Mode Bytes (HTTP) : texte complet → audio complet, moins de saccades (par défaut: true)
CARTESIA_USE_BYTES_MODE=true
# Continuations (WebSocket) : expérimental, peut augmenter les saccades si activé
CARTESIA_USE_CONTINUATIONS=false
```

**Logique de sélection de voix (comme Minimax / ElevenLabs) :**
- Si `assistantVoice === "male"` → `CARTESIA_VOICE_ID_MALE` ou `CARTESIA_VOICE_ID`
- Si `assistantVoice === "female"` → `CARTESIA_VOICE_ID_FEMALE` ou `CARTESIA_VOICE_ID`

### Variables optionnelles (valeurs par défaut)

```bash
# Modèle TTS (sonic-3 recommandé, supporte fr)
CARTESIA_MODEL_ID=sonic-3

# Format audio (Twilio MediaStream attend PCM 16 kHz mulaw)
CARTESIA_OUTPUT_FORMAT=pcm_mulaw
CARTESIA_SAMPLE_RATE=8000

# Version API Cartesia
CARTESIA_API_VERSION=2025-04-16

# Réglages Sonic-3 (optionnels)
CARTESIA_SPEED=1.0        # 0.6 à 1.5
CARTESIA_VOLUME=1.0       # 0.5 à 2.0
CARTESIA_LANGUAGE=fr      # Langue du transcript

# Mode Bytes (défaut) : audio complet puis enqueue fluide, évite saccades
CARTESIA_USE_BYTES_MODE=true
```

---

## Exemples de voice IDs Cartesia

L’API Cartesia expose 500+ voix. Quelques IDs recommandés pour les agents vocaux (voix stables) :

| Usage  | Voix recommandée (stable) | ID                                  |
|--------|---------------------------|-------------------------------------|
| Femme  | Katie                     | `f786b574-daa5-4673-aa0c-cbe3e8534c02` |
| Femme  | Jacqueline, Brooke        | [play.cartesia.ai](https://play.cartesia.ai/voices) (Featured ✓) |
| Homme  | Ronald, Carson            | [play.cartesia.ai](https://play.cartesia.ai/voices) (Featured ✓) |

Pour lister les voix par genre (GET `/voices?gender=masculine` ou `?gender=feminine`) :

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Cartesia-Version: 2025-04-16" \
     "https://api.cartesia.ai/voices?gender=feminine&limit=20"
```

---

## Récapitulatif des variables par fournisseur

| Variable          | Minimax | ElevenLabs | **Cartesia** |
|-------------------|---------|------------|--------------|
| API Key           | `MINIMAX_API_KEY` | `ELEVENLABS_API_KEY` | `CARTESIA_API_KEY` |
| Voix par défaut   | `MINIMAX_VOICE_ID` | `ELEVENLABS_VOICE_ID` | `CARTESIA_VOICE_ID` |
| Voix homme        | `MINIMAX_VOICE_ID_MALE` | `ELEVENLABS_VOICE_ID_MALE` | `CARTESIA_VOICE_ID_MALE` |
| Voix femme        | `MINIMAX_VOICE_ID_FEMALE` | `ELEVENLABS_VOICE_ID_FEMALE` | `CARTESIA_VOICE_ID_FEMALE` |
| Modèle            | `MINIMAX_MODEL` | `ELEVENLABS_MODEL_ID` | `CARTESIA_MODEL_ID` |

---

## Intégration côté autoguru-ai

Le choix voix **Homme / Femme** existe déjà dans les paramètres garage (`assistant_voice`). Aucun changement UI nécessaire : la valeur est envoyée via `stream.parameter({ name: "assistantVoice", value: assistantVoice })` et utilisée par le serveur pour choisir `CARTESIA_VOICE_ID_MALE` ou `CARTESIA_VOICE_ID_FEMALE`.

Pensez à mettre à jour le texte d’aide dans la page paramètres (ex. « Avec Cartesia : Femme → CARTESIA_VOICE_ID_FEMALE, Homme → CARTESIA_VOICE_ID_MALE ») une fois Cartesia intégré.

---

## Obtenir une clé API Cartesia

1. Créer un compte sur [cartesia.ai](https://cartesia.ai)
2. Accéder au dashboard → API Keys
3. Créer une clé et la copier dans `CARTESIA_API_KEY`

---

## Références

- [Cartesia TTS SSE](https://docs.cartesia.ai/api-reference/tts/sse)
- [Cartesia TTS WebSocket](https://docs.cartesia.ai/api-reference/tts/tts)
- [Liste des voix](https://docs.cartesia.ai/api-reference/voices/list)
- [Sonic-3 (modèles)](https://docs.cartesia.ai/build-with-cartesia/tts-models)
