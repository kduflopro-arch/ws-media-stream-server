# Configuration Minimax TTS

Ce document explique comment configurer Minimax TTS comme alternative à ElevenLabs pour la synthèse vocale.

## Variables d'environnement requises

Ajoutez ces variables dans votre service Render (ou autre hébergeur) :

```bash
# Activer le TTS premium
PREMIUM_TTS_ENABLED=true

# Sélectionner Minimax comme fournisseur
PREMIUM_TTS_PROVIDER=minimax

# Clés API Minimax
MINIMAX_API_KEY=votre_clé_api_minimax   # Obligatoire
MINIMAX_GROUP_ID=votre_group_id_minimax  # Optionnel : si défini = crédits abonnement Audio du groupe ; si non défini = facturation sur le solde du compte (pay-as-you-go). En cas d'erreur 2053 "insufficient credit" avec un abonnement, essayer sans MINIMAX_GROUP_ID pour utiliser le solde.

# IDs de voix (au moins un requis)
MINIMAX_VOICE_ID=votre_voice_id_par_défaut
MINIMAX_VOICE_ID_MALE=votre_voice_id_homme  # Optionnel
MINIMAX_VOICE_ID_FEMALE=votre_voice_id_femme  # Optionnel

# Paramètres de voix (optionnels)
MINIMAX_MODEL=speech-01  # Par défaut: speech-01
MINIMAX_SPEED=1.0        # 0.5 à 2.0, par défaut: 1.0
MINIMAX_VOLUME=1.0       # 0.0 à 1.0, par défaut: 1.0
MINIMAX_PITCH=0         # -12 à 12, par défaut: 0
```

## Comment obtenir vos clés Minimax

1. Créez un compte sur [Minimax](https://www.minimax.chat/)
2. Accédez à votre dashboard et créez un groupe (Group)
3. Récupérez votre `MINIMAX_API_KEY` et `MINIMAX_GROUP_ID`
4. Consultez la liste des voix disponibles dans la documentation Minimax
5. Sélectionnez les IDs de voix pour homme/femme selon vos besoins

## Configuration rapide dans Render

1. Allez dans votre service Render (ws-media-stream-server)
2. Cliquez sur "Environment" dans le menu de gauche
3. Ajoutez/modifiez ces variables :

```
PREMIUM_TTS_ENABLED=true
PREMIUM_TTS_PROVIDER=minimax
MINIMAX_API_KEY=sk-api-7ja0ltVW6qMM4Ooe9nbwBhX1fbG-SatPIElK9qhEK78aUhlA817H0Us91VBknzDdusPMmwlT55QXZJCNQK-gt5fTgzHS60ua6B0piNNEWXC21UWOS42FKy4
MINIMAX_GROUP_ID=votre_group_id_ici
MINIMAX_VOICE_ID=votre_voice_id_ici
```

**⚠️ IMPORTANT :** Remplacez `votre_group_id_ici` et `votre_voice_id_ici` par vos vraies valeurs depuis le dashboard Minimax.

## Configuration de la voix

Le système sélectionne automatiquement la voix selon le paramètre `assistantVoice` :
- Si `assistantVoice === "male"` → utilise `MINIMAX_VOICE_ID_MALE` ou `MINIMAX_VOICE_ID`
- Si `assistantVoice === "female"` → utilise `MINIMAX_VOICE_ID_FEMALE` ou `MINIMAX_VOICE_ID`

## Fallback automatique

Si Minimax échoue (erreur API, quota dépassé, etc.), le système bascule automatiquement sur l'audio OpenAI pour 5 minutes, puis réessaie Minimax.

## Comparaison avec ElevenLabs

| Fonctionnalité | Minimax | ElevenLabs |
|----------------|---------|------------|
| Format audio | PCM16 8kHz | PCM16 16kHz (rééchantillonné) |
| Latence | Variable selon modèle | Optimisable (0-4) |
| Qualité | Excellente pour le français | Excellente multilingue |
| Prix | À vérifier sur minimax.chat | Payant selon usage |

## Dépannage

### Erreur "Configuration Minimax incomplète"
- Vérifiez que `MINIMAX_API_KEY` et au moins un `MINIMAX_VOICE_ID` sont définis. `MINIMAX_GROUP_ID` est optionnel (voir ci-dessus).

### Erreur 2053 "insufficient credit"
- Si vous avez un abonnement Audio mais recevez 2053 : **retirez `MINIMAX_GROUP_ID`** des variables d'environnement (ou laissez-le vide) pour que la facturation utilise le **solde du compte** (pay-as-you-go) au lieu des crédits d'abonnement du groupe. Rechargez le solde sur https://platform.minimax.io/user-center/payment/balance si besoin.

### Pas d'audio généré
- Vérifiez les logs pour les erreurs API Minimax
- Vérifiez que `PREMIUM_TTS_ENABLED=true` et `PREMIUM_TTS_PROVIDER=minimax`
- Le système bascule automatiquement sur OpenAI en cas d'erreur

### Qualité audio insuffisante
- Ajustez `MINIMAX_SPEED`, `MINIMAX_VOLUME` et `MINIMAX_PITCH`
- Essayez un autre `MINIMAX_MODEL` (speech-01, speech-02, etc.)
- Testez différentes voix (`MINIMAX_VOICE_ID_*`)
