# Serveur WebSocket Media Streams (Skeleton)

But : héberger un endpoint WebSocket pour Twilio Media Streams (temps réel). À déployer sur Render / Railway / Fly (pas Vercel).

## Déploiement rapide (Render)
1. Crée un nouveau service Web sur Render.
2. Connecte ce repo ou pousse ce dossier.
3. Build command : *(vide)* (Node sans build)
4. Start command : `node server.js`
5. PORT : géré par Render (variable `PORT`).

## Déploiement automatique à chaque push

**Option A – Auto-Deploy Render (recommandé)**  
Dans le dashboard Render → service ws-media-stream-server → **Settings** → **Build & Deploy** : active **Auto-Deploy** sur la branche (ex. `main`). Chaque push sur cette branche déclenche un déploiement.

**Option B – GitHub Actions + Deploy Hook**  
Le workflow `.github/workflows/deploy-ws-media-stream.yml` déclenche un déploiement à chaque push sur `main`/`master` quand des fichiers sous `ws-media-stream-server/` changent. À configurer une seule fois :
1. Render → service → **Settings** → **Deploy Hook** → copier l’URL.
2. GitHub → dépôt → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** : nom `RENDER_DEPLOY_HOOK_URL`, valeur = l’URL du deploy hook.
3. À chaque push sur `main`/`master` modifiant `ws-media-stream-server/`, le déploiement Render est lancé.

## Webhook Twilio (TwiML)
Dans “A CALL COMES IN”, pointe vers un TwiML qui démarre le stream :
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://<votre-render-service>.onrender.com/stream" />
  </Start>
  <Say language="fr-FR" voice="alice">Connexion en cours. Parlez, je vous écoute.</Say>
</Response>
```

## À compléter (TODO)
- Brancher OpenAI Realtime (Speech-to-Speech) pour :
  - envoyer les frames audio (base64 mu-law 8k) vers OpenAI
  - recevoir le TTS streamé et le renvoyer à Twilio (bistream)
- Gérer le barge-in et le routage des réponses.

## Notes
- Ce serveur est un squelette minimal (log des frames, pas de traitement).
- Vercel ne convient pas pour WS persistants, d’où Render/Railway.

# -Users-kendrikduflo-Documents-AutoGuru-ws-media-stream-server
