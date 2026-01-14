# Configuration TTS - Alternatives à ElevenLabs

## 🎯 Recommandation : OpenAI TTS (déjà intégré)

**Avantages :**
- ✅ Déjà intégré dans le code
- ✅ Excellent rapport qualité/prix (~$15 pour 1M de caractères)
- ✅ Paiement à l'usage uniquement (pas d'abonnement)
- ✅ Très bonne qualité vocale
- ✅ Latence faible

**Configuration Render :**
```
REALTIME_TTS_MODE=openai
PREMIUM_TTS_ENABLED=false
```

Cela désactive ElevenLabs et utilise directement l'audio OpenAI Realtime.

---

## 📊 Comparaison des alternatives

### 1. OpenAI TTS (Recommandé ⭐)
- **Prix** : ~$15 pour 1M de caractères
- **Qualité** : ⭐⭐⭐⭐⭐ (excellente)
- **Latence** : Très faible
- **Avantage** : Déjà intégré, pas de configuration supplémentaire

### 2. SpeechGen.io
- **Prix** : ~$0,20 pour 1000 caractères (pack de 25 000 caractères à $4,99)
- **Qualité** : ⭐⭐⭐⭐ (très bonne)
- **Voix** : 1000+ voix, 150+ langues
- **Avantage** : Paiement unique, pas d'abonnement
- **Note** : Nécessite une intégration dans le code

### 3. Google Cloud Text-to-Speech
- **Prix** : ~$4 pour 1M de caractères (standard), ~$16 (WaveNet premium)
- **Qualité** : ⭐⭐⭐⭐⭐ (WaveNet est excellent)
- **Avantage** : Paiement à l'usage uniquement
- **Note** : Nécessite une intégration dans le code

### 4. Azure Cognitive Services Speech
- **Prix** : ~$4 pour 1M de caractères
- **Qualité** : ⭐⭐⭐⭐ (très bonne)
- **Avantage** : Paiement à l'usage uniquement
- **Note** : Nécessite une intégration dans le code

---

## 🔧 Comment activer OpenAI TTS

### Sur Render (Variables d'environnement)

1. Allez dans votre service Render
2. Section "Environment"
3. Modifiez ou ajoutez :
   ```
   REALTIME_TTS_MODE=openai
   PREMIUM_TTS_ENABLED=false
   ```
4. Redéployez le service

### Résultat

- ✅ L'IA utilisera directement l'audio OpenAI (pas besoin d'ElevenLabs)
- ✅ Coût : ~$15 pour 1M de caractères (beaucoup moins cher qu'ElevenLabs)
- ✅ Qualité : Excellente
- ✅ Pas d'abonnement, paiement à l'usage uniquement

---

## 💡 Pourquoi OpenAI TTS est recommandé

1. **Déjà intégré** : Le code gère déjà le fallback vers OpenAI TTS
2. **Meilleur rapport qualité/prix** : Moins cher qu'ElevenLabs avec une qualité similaire
3. **Pas d'abonnement** : Paiement uniquement pour ce que vous utilisez
4. **Fiabilité** : Pas de problème de quota comme avec ElevenLabs

---

## 📝 Notes

- Si vous voulez vraiment utiliser SpeechGen.io ou Google Cloud TTS, il faudra modifier le code pour ajouter leur intégration
- OpenAI TTS est la solution la plus simple et la plus économique pour votre cas d'usage
