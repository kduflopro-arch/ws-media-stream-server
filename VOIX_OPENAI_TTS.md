# Voix disponibles avec OpenAI TTS

## 🎙️ Voix API Realtime (utilisées dans votre code)

Votre système utilise l'**API Realtime OpenAI**, qui propose les voix suivantes :

### Voix féminines recommandées pour un garage :
- **Cove** — posée et directe ⭐ (professionnelle)
- **Spruce** — calme et rassurante ⭐ (apaisante)
- **Cedar** — exclusive Realtime (optimisée temps réel) ⭐
- **Marin** — exclusive Realtime (optimisée temps réel) ⭐
- **Ember** — assurée et optimiste
- **Juniper** — ouverte et enjouée
- **Maple** — joyeuse et naturelle

### Voix masculines recommandées :
- **Sol** — avisée et décontractée ⭐
- **Arbor** — détendue et polyvalente
- **Cove** — posée et directe (unisexe)

### Toutes les voix disponibles :
1. **Arbor** — détendue et polyvalente
2. **Breeze** — vive et sincère
3. **Cove** — posée et directe
4. **Ember** — assurée et optimiste
5. **Juniper** — ouverte et enjouée
6. **Maple** — joyeuse et naturelle
7. **Sol** — avisée et décontractée
8. **Spruce** — calme et rassurante
9. **Vale** — vive et curieuse
10. **Cedar** — exclusive API Realtime (optimisée temps réel)
11. **Marin** — exclusive API Realtime (optimisée temps réel)

---

## ⚙️ Configuration actuelle

Actuellement, votre code utilise l'audio directement depuis l'API Realtime, donc la voix est déterminée par la configuration de la session OpenAI.

**Note importante :** L'API Realtime OpenAI ne permet pas de choisir directement la voix via un paramètre. La voix est déterminée automatiquement par OpenAI selon le contexte et les instructions.

Cependant, vous pouvez influencer le style vocal via les **instructions de session** dans le prompt.

---

## 🔧 Comment influencer la voix

Bien que vous ne puissiez pas choisir directement la voix, vous pouvez influencer le style via les instructions :

```javascript
// Dans les instructions de session, vous pouvez ajouter :
"Parle avec une voix calme et rassurante" // → Spruce
"Parle avec une voix posée et professionnelle" // → Cove
"Parle avec une voix assurée et optimiste" // → Ember
```

---

## 📝 Voix TTS standard (si vous utilisez l'API TTS classique)

Si vous basculez vers l'API TTS standard (non Realtime), vous avez accès à :
- **Alloy** (neutre)
- **Echo** (neutre)
- **Fable** (neutre)
- **Onyx** (masculine)
- **Nova** (féminine)
- **Shimmer** (féminine)
- **Ash** (masculine)
- **Ballad** (féminine)
- **Coral** (féminine)
- **Sage** (masculine)

**Note :** Ces voix nécessitent une modification du code pour utiliser l'API TTS standard au lieu de Realtime.

---

## 💡 Recommandation

Pour votre usage (appels téléphoniques garage), les meilleures voix sont :
- **Cove** ou **Spruce** pour une voix féminine professionnelle
- **Sol** pour une voix masculine
- **Cedar** ou **Marin** pour une qualité optimale en temps réel

Ces voix sont automatiquement sélectionnées par OpenAI selon le contexte de votre conversation.

---

## 🎯 Test des voix

Pour tester les différentes voix, vous pouvez :
1. Modifier les instructions de session pour influencer le style
2. Tester plusieurs appels et noter quelle voix est utilisée
3. Ajuster les instructions selon vos préférences
