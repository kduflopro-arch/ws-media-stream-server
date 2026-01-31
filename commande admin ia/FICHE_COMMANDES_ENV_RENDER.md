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

## Valeurs recommandées (baseline stable à copier/coller)

> Objectif : **arrêter les “l’IA ne répond pas”** et limiter les coupures dues au bruit/TV.

- `INPUT_GATE_ENABLED=false`
- `BARGE_IN_ENABLED=false`
- `GREETING_DELAY_MS=150`
- `GREETING_ONCE_PER_CALL=true`
- `GREETING_ONCE_TTL_MS=600000`
- `OUTPUT_GAIN=1.25`
- `LOCAL_COMMIT_ENABLED=false`

---

## Variables “voix & naturel”

### `OPENAI_VOICE`
- **Statut** : **à utiliser uniquement si ça ne génère pas d’erreur**.
- **Note** : sur certains modèles Realtime, tenter de fixer la voix via un champ de requête peut provoquer :
  `Unknown parameter: 'response.voice'`.
- **Action** : si tu vois cette erreur, **supprime `OPENAI_VOICE`** et on fixera la voix autrement (ou via un autre provider TTS).

---

## Solution premium (voix masculine ultra naturelle)

> Objectif : garder OpenAI pour comprendre/répondre, mais faire la **voix** via un TTS premium (ex: ElevenLabs).
> Ça apporte l’intonation/émotion qui manque souvent en Realtime.

### `PREMIUM_TTS_ENABLED`
- **Rôle** : active le mode premium (remplace l’audio OpenAI par une voix TTS).
- **Défaut** : `false`
- **Valeurs** : `true` / `false`

### `PREMIUM_TTS_PROVIDER`
- **Rôle** : provider de TTS premium.
- **Défaut** : `elevenlabs`
- **Valeurs** : `elevenlabs`

### `ELEVENLABS_API_KEY`
- **Rôle** : clé API ElevenLabs.
- **Obligatoire si premium** : oui.

### `ELEVENLABS_VOICE_ID`
- **Rôle** : ID de la voix (choisir une **voix masculine FR** côté ElevenLabs).
- **Obligatoire si premium** : oui.

### `ELEVENLABS_MODEL_ID`
- **Rôle** : modèle ElevenLabs (qualité/latence).
- **Valeur conseillée (FR)** : `eleven_multilingual_v2`

---

## Intégration AutoGuru (remplir “détails d’appel” en mode Realtime)

> Objectif : quand tu utilises `PIPELINE_MODE=realtime`, AutoGuru n’a pas forcément de transcript via Twilio.
> Ces variables permettent au serveur WS de pousser le transcript vers AutoGuru au fil de l’appel.

### `AUTOGURU_INGEST_URL`
- **Rôle** : URL du endpoint AutoGuru qui reçoit les phrases Realtime.
- **Exemple** : `https://<TON_AUTOGURU>/api/twilio/realtime-ingest`
- **Obligatoire** : oui si tu veux les détails d’appel.

### `AUTOGURU_INGEST_SECRET`
- **Rôle** : secret partagé entre Render (WS) et AutoGuru (API) pour autoriser l’ingestion.
- **Conseil** : une clé longue (32+ caractères).
- **Obligatoire** : oui si tu veux les détails d’appel.
- **Défaut** : `eleven_multilingual_v2`

### `ELEVENLABS_OUTPUT_FORMAT`
- **Rôle** : format audio de sortie demandé à ElevenLabs.
- **Défaut** : `pcm_16000` (plus simple à convertir en μ-law 8kHz pour Twilio)

---

## Option B (recommandée) — STT → GPT (texte) → ElevenLabs (voix)

> Objectif : améliorer **la compréhension** (STT téléphonie) et le **texte** (LLM plus puissant), tout en gardant la voix ElevenLabs.
> Mode conseillé si tu dis “il ne comprend pas ce que je dis”.

### `STT_PROMPT`
- **Rôle** : “boost” de compréhension Whisper (vocabulaire garage + format plaques FR).
- **Quand l’utiliser** : si tu constates des incompréhensions sans bruit de fond.
- **Exemple** :
  - `STT_PROMPT=Garage auto. Français. Termes: vidange, freins, plaquettes, disques, embrayage, distribution, pneus, climatisation, diagnostic. Plaque FR: AB-123-CD.`

### `PIPELINE_MODE`
- **Rôle** : choisit le pipeline.
- **Défaut** : `realtime`
- **Valeurs** :
  - `realtime` : OpenAI Realtime (audio) + (option) ElevenLabs voix
  - `gpt-realtime` : **alias accepté** (équivalent à `realtime`)
  - `stt_llm_tts` : **Option B** (VAD local → Whisper → LLM texte → ElevenLabs)

### `REALTIME_TTS_MODE`
- **Rôle** : en mode `realtime`, choisit qui “parle”.
- **Défaut** : `openai`
- **Valeurs** :
  - `openai` : on utilise l’audio OpenAI Realtime (plus simple).
  - `elevenlabs` : on **ignore l’audio OpenAI** et on fait parler **ElevenLabs** à partir du transcript Realtime (voix plus humaine).
- **Requis pour ElevenLabs en realtime** : mettre `REALTIME_TTS_MODE=elevenlabs` **et** `PREMIUM_TTS_ENABLED=true` + clés ElevenLabs.

### `STT_MODEL`
- **Rôle** : modèle de transcription.
- **Défaut** : `whisper-1`

### `STT_LANGUAGE`
- **Rôle** : langue de transcription.
- **Défaut** : `fr`

### `LLM_MODEL`
- **Rôle** : modèle “cerveau” (texte). Tu peux mettre `gpt-5` si ton compte y a accès.
- **Défaut** : `gpt-4o`
- **Note** : si `gpt-5` n’est pas disponible, le serveur **fallback** sur `gpt-4o`.

### `LLM_TEMPERATURE`
- **Rôle** : créativité / naturel.
- **Défaut** : `0.4`

### `LLM_MAX_TOKENS`
- **Rôle** : longueur max des réponses.
- **Défaut** : `160` (plus rapide)

### VAD STT (détection de fin de phrase)
- **`STT_SPEECH_THRESHOLD`** (défaut `2200`)
- **`STT_SPEECH_FRAMES`** (défaut `6` ≈ 120ms)
- **`STT_SILENCE_THRESHOLD`** (défaut `900`)
- **`STT_SILENCE_FRAMES`** (défaut `18` ≈ 360ms) *(adaptatif : plus rapide sur phrases longues)*
- **`STT_MIN_AUDIO_MS`** (défaut `350`)

### Si “il ne comprend pas ce que je dis” (voix faible / micro téléphone)
- **Option 1 (recommandée)** : passer en Option B
  - `PIPELINE_MODE=stt_llm_tts`
  - `STT_LANGUAGE=fr`
  - `STT_MIN_AUDIO_MS=550`
  - `STT_SILENCE_FRAMES=24`
- **Option 2 (si tu restes en realtime)** : rendre le gate moins agressif
  - `INPUT_GATE_ENABLED=false` (le plus simple si pas de TV/bruit)
  - ou baisser `INPUT_SPEECH_THRESHOLD` (ex: `900`) et `INPUT_SILENCE_THRESHOLD` (ex: `450`)

### `BACKCHANNEL_ENABLED`
- **Rôle** : joue un micro “accusé de réception” juste après ta phrase (ex: “D’accord, je note…”) pour que ça paraisse instantané.
- **Défaut** : `true`

### `BACKCHANNEL_TEXT`
- **Rôle** : texte du backchannel.
- **Défaut** : `D'accord, je note…`

### `BACKCHANNEL_DELAY_MS`
- **Rôle** : délai avant de jouer le backchannel (si la réponse tarde).
- **Défaut** : `1500`

### `BACKCHANNEL_MIN_INTERVAL_MS`
- **Rôle** : anti-spam backchannel (min. entre deux).
- **Défaut** : `20000`

### `LLM_TIMEOUT_MS`
- **Rôle** : timeout (ms) sur l’appel LLM (évite “aucune réponse” si le modèle bloque).
- **Défaut** : `15000` *(GPT‑5 peut nécessiter plus ; on force un minimum côté serveur)*

---

## Tuning latence (Realtime)

### `WATCHDOG_AFTER_COMMIT_MS`
- **Rôle** : délai avant de forcer un `response.create` si OpenAI n’a pas démarré sa réponse.
- **Défaut** : `250`

### `RESPONSE_CREATE_DEBOUNCE_MS`
- **Rôle** : anti-spam `response.create` (plus bas = plus réactif, plus haut = moins de requêtes/minute → moins de rate limit TPM).
- **Défaut** : `700`
- **Si rate limit TPM** : essayer `1000` pour espacer les requêtes.

---

## Variables Rate limit OpenAI (TPM)

Si vous voyez **"RATE LIMIT OpenAI (TPM)"** dans les logs :

1. **Vérifier le tier** : https://platform.openai.com/account/rate-limits — Tier 1 = 10k TPM pour gpt-4o-realtime.
2. **Augmenter le buffer avant retry** : `OPENAI_RATE_LIMIT_RETRY_BUFFER_SECONDS=12` (défaut) ou `15` pour attendre plus longtemps avant de réessayer.
3. **Limiter les retries** : `OPENAI_RATE_LIMIT_MAX_RETRIES=2` (défaut) — chaque retry consomme encore des tokens.
4. **Espacer les requêtes** : `RESPONSE_CREATE_DEBOUNCE_MS=1000` pour moins de `response.create` par minute.

### `OPENAI_RATE_LIMIT_RETRY_BUFFER_SECONDS`
- **Rôle** : secondes ajoutées au délai "try again in Xs" avant de refaire un `response.create` après rate limit.
- **Défaut** : `12`
- **Conseil** : si vous restez en rate limit, monter à `15` ou `20`.

### `OPENAI_RATE_LIMIT_MAX_RETRIES`
- **Rôle** : nombre max de retries après un rate limit (par "tour" de réponse). Au-delà, on ne réessaie plus (évite d’aggraver le TPM).
- **Défaut** : `2`


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

### `GREETING_ONCE_PER_CALL`
- **Rôle** : empêche l’IA de répéter l’accueil si Twilio reconnecte le stream pendant **le même appel** (même `CallSid`).
- **Défaut** : `true`
- **Recommandé** : laisse `true` (ça règle le “bonjour” répété).

### `GREETING_ONCE_TTL_MS`
- **Rôle** : durée pendant laquelle on considère que “l’accueil a déjà été joué” pour un `CallSid`.
- **Défaut** : `600000` (10 minutes)

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
- **Défaut** : `false` (plus fiable : évite “l’IA ne répond pas”)
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

### `INPUT_SUPPRESS_WHILE_TALKING`
- **Rôle** : anti-écho/anti-TV. Quand l’IA parle, on n’envoie pas l’audio entrant à OpenAI (évite réponses tronquées + coupures).
- **Défaut** : `true`
- **Valeurs** : `true` / `false`

### `INPUT_SUPPRESS_BACKLOG_FRAMES`
- **Rôle** : seuil (frames 20ms) de backlog audio sortant au-delà duquel on considère que “l’IA parle”.
- **Défaut** : `5` (~100ms)

### `ELEVENLABS_MAX_BACKLOG_SECONDS`
- **Rôle** : limite le débit du TTS ElevenLabs pour éviter d’envoyer l’audio en rafales (Twilio peut “drop” → coupures).
- **Défaut** : `3` (secondes)
- **Conseils** :
  - Si tu entends des coupures → baisse `2`
  - Si tu entends de la latence (retard) → monte `4`

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


