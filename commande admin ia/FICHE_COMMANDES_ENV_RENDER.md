# Commandes Admin IA — Variables d’environnement Render

Ce document liste **toutes les variables d’environnement Render** utilisées par le serveur `ws-media-stream-server` (Twilio Media Streams ↔ OpenAI Realtime) et explique **à quoi elles servent**, **quand les modifier**, et **des valeurs conseillées**.

> Rappel : ces variables se modifient dans Render → *Service* → **Environment** → **Add Environment Variable** → **Save Changes** (déclenche un redeploy).

---

## Variables obligatoires

### `OPENAI_API_KEY`
- **Rôle** : clé API OpenAI pour la connexion Realtime.
- **Obligatoire** : oui.
- **Valeur** : une clé OpenAI valide (format `sk-...`).
- **Symptômes si manquante** : l’IA ne se connecte pas, pas de réponse audio.

---

## Variables “qualité audio” (recommandées)

### `OUTPUT_GAIN`
- **Rôle** : augmente/diminue le volume **avant encodage μ-law** (améliore l’intelligibilité en téléphonie).
- **Défaut** : `1.25`
- **Conseils** :
  - Si **trop faible** → monte progressivement : `1.35` puis `1.45`
  - Si **ça sature / grésille** → baisse : `1.15` puis `1.05`
- **Exemple** :
  - `OUTPUT_GAIN=1.15`

---

## Variables “voix & naturel”

### `OPENAI_VOICE`
- **Rôle** : choisit la **voix TTS** côté OpenAI (quand supporté).
- **Défaut** : *(vide)* → on laisse OpenAI choisir la voix par défaut.
- **Conseils** :
  - Si une voix est “plus humaine” pour toi, fixe-la ici.
  - Si tu observes une erreur côté OpenAI après ajout, supprime la variable (ou vide la valeur).
- **Exemple** :
  - `OPENAI_VOICE=alloy`

---

## Variables “interruption / barge-in” (important si TV/bruit en fond)

> Si tu as la TV en fond, le barge-in peut provoquer des **coupures** (l’IA pense que tu l’interromps).

### `BARGE_IN_ENABLED`
- **Rôle** : active/désactive l’interruption de l’IA quand l’appelant parle pendant que l’IA parle.
- **Défaut** : `false` (désactivé par défaut pour éviter les coupures sur bruit/TV)
- **Valeurs** : `true` / `false`
- **Exemple** :
  - `BARGE_IN_ENABLED=true`

### `BARGE_IN_THRESHOLD`
- **Rôle** : seuil (énergie) à dépasser pour considérer qu’il y a “vraie parole” côté Twilio.
- **Défaut** : `5500`
- **Conseils** :
  - **TV/bruit déclenche encore** → augmente : `6500` → `8000`
  - **Tu dois répéter pour couper** → baisse : `4500`
- **Exemple** :
  - `BARGE_IN_THRESHOLD=7000`

### `BARGE_IN_FRAMES`
- **Rôle** : durée minimale (en frames de 20ms) avant d’interrompre.
- **Défaut** : `12` (≈ 240ms)
- **Conseils** :
  - Pour éviter les faux positifs → augmente : `20` (≈ 400ms)
  - Pour couper plus vite → baisse : `8` (≈ 160ms)
- **Exemple** :
  - `BARGE_IN_FRAMES=20`

---

## Variables système (Render)

### `PORT`
- **Rôle** : port d’écoute du serveur.
- **Défaut** : géré par Render automatiquement.
- **À faire** : en général **ne pas toucher**.

---

## Variables présentes mais actuellement ignorées / non recommandées

### `OPENAI_AUDIO_FORMAT`
- **Statut** : **ignorée** (le serveur force `pcm16` en entrée/sortie Realtime pour éviter le “brouillage”).
- **Pourquoi** : sur nos tests, demander `g711_ulaw` a mené à des mismatches audio (Twilio jouait du bruit).
- **Action** : ne pas utiliser pour l’instant.

---

## Procédure “safe” pour modifier une variable

1. Changer **une seule variable à la fois**
2. Faire un appel test de 30–60s
3. Noter : volume / saturation / coupures / naturel
4. Ajuster à nouveau (petits pas)

---

## Valeurs recommandées (profil “garage réel”)

- `OUTPUT_GAIN=1.15` à `1.35` (selon ton volume)
- `OPENAI_VOICE=...` (celle qui te paraît la plus naturelle)
- `BARGE_IN_ENABLED=false` si TV/bruit (sinon `true`)
- Si barge-in activé :
  - `BARGE_IN_THRESHOLD=6500`
  - `BARGE_IN_FRAMES=20`


