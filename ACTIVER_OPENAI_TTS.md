# 🎙️ Activer OpenAI TTS

## Configuration Render (Variables d'environnement)

Pour activer OpenAI TTS et désactiver ElevenLabs, modifiez les variables d'environnement sur Render :

### Variables à modifier/ajouter :

```
REALTIME_TTS_MODE=openai
PREMIUM_TTS_ENABLED=false
```

### Étapes :

1. Allez sur [Render Dashboard](https://dashboard.render.com)
2. Sélectionnez votre service `ws-media-stream-server`
3. Allez dans l'onglet **"Environment"**
4. Modifiez ou ajoutez :
   - `REALTIME_TTS_MODE` = `openai`
   - `PREMIUM_TTS_ENABLED` = `false`
5. Cliquez sur **"Save Changes"**
6. Render redéploiera automatiquement le service

### Résultat attendu :

✅ L'IA utilisera directement l'audio OpenAI (pas besoin d'ElevenLabs)
✅ Coût : ~$15 pour 1M de caractères (beaucoup moins cher)
✅ Qualité : Très bonne (77% précision vs 82% pour ElevenLabs)
✅ Pas de problème de quota
✅ Voix naturelles (Cedar, Marin, Cove, Spruce, etc.)

### Variables à garder (ne pas supprimer) :

- `OPENAI_API_KEY` (obligatoire)
- `PIPELINE_MODE=realtime` (obligatoire)
- Toutes les autres variables existantes

### Variables ElevenLabs (peuvent être supprimées ou laissées) :

- `ELEVENLABS_API_KEY` (non utilisée si PREMIUM_TTS_ENABLED=false)
- `ELEVENLABS_VOICE_ID` (non utilisée)
- `PREMIUM_TTS_PROVIDER` (non utilisée)

---

## ⚡ Test rapide

Après le redéploiement :
1. Faites un appel test
2. Vérifiez que l'IA parle (audio OpenAI)
3. Vérifiez les logs Render pour confirmer :
   - `REALTIME_TTS_MODE: 'openai'`
   - `PREMIUM_TTS_ENABLED: false`
   - Pas d'erreur ElevenLabs

---

## 🔄 Revenir à ElevenLabs (si besoin)

Si vous voulez revenir à ElevenLabs plus tard :
```
REALTIME_TTS_MODE=elevenlabs
PREMIUM_TTS_ENABLED=true
```

Mais assurez-vous d'avoir rechargé votre quota ElevenLabs avant !
