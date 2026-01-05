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
- **Statut** : **à utiliser uniquement si ça ne génère pas d’erreur**.
- **Note** : sur certains modèles Realtime, tenter de fixer la voix via un champ de requête peut provoquer :
  `Unknown parameter: 'response.voice'`.
- **Action** : si tu vois cette erreur, **supprime `OPENAI_VOICE`** et on fixera la voix autrement (ou via un autre provider TTS).

---

## Variables “persona / style” (rendre l’IA comme un mécanicien)

### `ASSISTANT_PERSONA`
- **Rôle** : choisit le style global de communication (script + vocabulaire).
- **Défaut** : `mecanicien`
- **Valeurs** :
  - `mecanicien` : ton garage, humain, rassurant, vocabulaire simple de mécanique
  - `neutre` : assistant pro, plus “standard”
- **Exemple** :
  - `ASSISTANT_PERSONA=mecanicien`

---

## Variables “accueil / latence”

### `GREETING_DELAY_MS`
- **Rôle** : délai (ms) avant que l’IA lance son “Oui allô, bonjour…” après connexion.
- **Défaut** : `150`
- **Conseils** :
  - Si l’IA démarre trop tôt → `300`
  - Si c’est trop lent → `0` à `100`

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

## Variables “anti-TV / anti-bruit” (évite que l’IA réponde toute seule)

> Si tu as une TV en fond, sans filtre l’API peut détecter de la “parole” et **répondre sans que tu parles**.
> Le serveur inclut maintenant un **noise gate** (VAD local) configurable.

### `INPUT_GATE_ENABLED`
- **Rôle** : active/désactive le filtrage d’entrée (ne pas envoyer le bruit à OpenAI).
- **Défaut** : `true`
- **Valeurs** : `true` / `false`

### `INPUT_SPEECH_THRESHOLD`
- **Rôle** : seuil au-dessus duquel on considère que l’audio est “parole” côté Twilio.
- **Défaut** : `2500`
- **Conseils** :
  - Si la TV déclenche encore → **augmente** : `3500` → `5000`
  - Si tu dois parler très fort → **baisse** : `1800`

### `INPUT_SPEECH_FRAMES`
- **Rôle** : nombre de frames (20ms) de “parole” consécutives avant de démarrer une prise de parole.
- **Défaut** : `6` (~120ms)
- **Conseils** :
  - Plus strict (anti TV) → `10` (~200ms)

### `INPUT_SILENCE_THRESHOLD`
- **Rôle** : seuil en dessous duquel on considère “silence”.
- **Défaut** : `1200`

### `INPUT_SILENCE_FRAMES`
- **Rôle** : nombre de frames de silence (20ms) avant de “clôturer” une prise de parole et faire un commit.
- **Défaut** : `20` (~400ms)
- **Conseils** :
  - Si ça coupe trop vite → `30` (~600ms)

---

## Variables avancées (debug)

### `LOCAL_COMMIT_ENABLED`
- **Rôle** : autorise le serveur à envoyer `input_audio_buffer.commit` lui-même (au lieu de laisser OpenAI auto-commit).
- **Défaut** : `false`
- **Attention** : peut réintroduire `commit_empty` si mal réglé.

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


