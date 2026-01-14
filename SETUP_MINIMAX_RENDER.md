# Configuration Minimax dans Render

## Variables d'environnement à ajouter

Dans votre service Render (ws-media-stream-server), allez dans **Environment** et ajoutez/modifiez :

### Variables obligatoires

```bash
PREMIUM_TTS_ENABLED=true
PREMIUM_TTS_PROVIDER=minimax
REALTIME_TTS_MODE=openai  # ⚠️ IMPORTANT: laissez "openai" (c'est pour le mode Realtime, Minimax sera utilisé via PREMIUM_TTS_PROVIDER)
MINIMAX_API_KEY=sk-api-7ja0ltVW6qMM4Ooe9nbwBhX1fbG-SatPIElK9qhEK78aUhlA817H0Us91VBknzDdusPMmwlT55QXZJCNQK-gt5fTgzHS60ua6B0piNNEWXC21UWOS42FKy4
MINIMAX_GROUP_ID=votre_group_id_minimax
MINIMAX_VOICE_ID=votre_voice_id_minimax
```

**Note importante sur `REALTIME_TTS_MODE` :**
- Laissez `REALTIME_TTS_MODE=openai` (valeur par défaut)
- Cette variable contrôle le mode Realtime (OpenAI Realtime API)
- Minimax sera utilisé automatiquement via `PREMIUM_TTS_PROVIDER=minimax`

### Variables optionnelles (avec valeurs par défaut)

```bash
MINIMAX_VOICE_ID_MALE=voice_id_homme  # Si vous voulez une voix différente pour homme
MINIMAX_VOICE_ID_FEMALE=voice_id_femme  # Si vous voulez une voix différente pour femme
MINIMAX_MODEL=speech-01  # Modèle TTS (speech-01, speech-02, etc.)
MINIMAX_SPEED=1.0        # Vitesse de lecture (0.5 à 2.0)
MINIMAX_VOLUME=1.0       # Volume (0.0 à 1.0)
MINIMAX_PITCH=0          # Hauteur de voix (-12 à 12)
```

## Comment obtenir MINIMAX_GROUP_ID et MINIMAX_VOICE_ID

1. Connectez-vous à votre compte [Minimax](https://www.minimax.chat/)
2. Allez dans votre dashboard
3. Créez ou sélectionnez un **Groupe (Group)** → c'est votre `MINIMAX_GROUP_ID`
4. Consultez la liste des **voix disponibles** → sélectionnez un `voice_id`
5. Si vous voulez des voix différentes pour homme/femme, notez les IDs correspondants

## Après configuration

1. **Redéployez** votre service Render (ou attendez le redéploiement automatique)
2. Vérifiez les logs au démarrage : vous devriez voir `PREMIUM_TTS_PROVIDER: minimax`
3. Testez un appel pour vérifier que Minimax fonctionne

## Dépannage

### Erreur "Configuration Minimax incomplète"
- Vérifiez que `MINIMAX_API_KEY`, `MINIMAX_GROUP_ID` et `MINIMAX_VOICE_ID` sont tous définis
- Vérifiez qu'il n'y a pas d'espaces avant/après les valeurs

### Pas d'audio
- Vérifiez les logs Render pour les erreurs API Minimax
- Vérifiez que `PREMIUM_TTS_ENABLED=true` et `PREMIUM_TTS_PROVIDER=minimax`
- Le système bascule automatiquement sur OpenAI TTS en cas d'erreur

### Qualité audio
- Ajustez `MINIMAX_SPEED`, `MINIMAX_VOLUME`, `MINIMAX_PITCH`
- Essayez un autre `MINIMAX_MODEL` (speech-01, speech-02, etc.)
