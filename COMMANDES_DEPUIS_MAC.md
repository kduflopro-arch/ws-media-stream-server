# Commandes — Depuis ton Mac

Tout se fait depuis le Terminal de ton Mac, sans ouvrir la console Hetzner.

---

## 1) Connexion rapide

```bash
# Ouvrir un shell sur le serveur
ssh root@88.198.149.117

# Exécuter une commande distante sans ouvrir de shell
ssh root@88.198.149.117 "pm2 status"
```

---

## 2) Santé du serveur WS

```bash
# Health check public
curl https://ws.server-kd.88-198-149-117.sslip.io/health

# Vérifier SSL/headers
curl -I https://ws.server-kd.88-198-149-117.sslip.io
```

---

## 3) PM2 (process WS)

```bash
# État
ssh root@88.198.149.117 "pm2 status"

# Logs live (Ctrl+C pour sortir)
ssh root@88.198.149.117 "pm2 logs ws-server-kd"

# 30 dernières lignes
ssh root@88.198.149.117 "pm2 logs ws-server-kd --lines 30 --nostream"

# Redémarrer
ssh root@88.198.149.117 "pm2 restart 0 --update-env"

# Vérifier les variables réellement chargées par PM2
ssh root@88.198.149.117 "pm2 env 0"
```

> Utilise `pm2 restart 0 --update-env` après toute modif du `.env`.

---

## 4) Variables d'environnement WS (`.env`)

```bash
# Afficher toutes les variables
ssh root@88.198.149.117 "cd /opt/ws-media-stream-server && cat .env"

# Afficher uniquement les noms de variables
ssh root@88.198.149.117 "cd /opt/ws-media-stream-server && sed 's/=.*//' .env"

# Modifier une variable existante
ssh root@88.198.149.117 "cd /opt/ws-media-stream-server && sed -i 's|^NOM_VARIABLE=.*|NOM_VARIABLE=nouvelle_valeur|' .env"

# Ajouter une variable si elle n'existe pas
ssh root@88.198.149.117 "cd /opt/ws-media-stream-server && echo 'NOM_VARIABLE=valeur' >> .env"

# Redémarrer en rechargeant l'env
ssh root@88.198.149.117 "pm2 restart 0 --update-env"

# Contrôler la valeur dans le process PM2
ssh root@88.198.149.117 "pm2 env 0 | grep '^NOM_VARIABLE:'"
```

---

## 5) Transfert de fichiers (scp)

```bash
# Envoyer un fichier
scp fichier.txt root@88.198.149.117:/opt/ws-media-stream-server/

# Envoyer un dossier
scp -r dossier/ root@88.198.149.117:/opt/ws-media-stream-server/

# Récupérer un fichier
scp root@88.198.149.117:/opt/ws-media-stream-server/.env ~/Downloads/
```

---

## 6) Déploiement Git du serveur WS

```bash
cd /Users/kendrikduflo/Documents/AutoGuru/ws-media-stream-server
git status
git add .
git commit -m "description"
git push origin main
```

Le push sur `main` déclenche le workflow de déploiement vers Hetzner.

---

## 7) Variables Vercel (autoguru-ai)

```bash
cd /Users/kendrikduflo/Documents/AutoGuru/autoguru-ai

# Lister
npx vercel env ls production

# Ajouter
npx vercel env add NOM_VARIABLE production

# Supprimer
npx vercel env rm NOM_VARIABLE production

# Déployer en prod
npx vercel --prod
```

Variable WS recommandée en prod :

```bash
WS_MEDIA_STREAM_URL_RESTAURANT=wss://ws.server-kd.88-198-149-117.sslip.io
```

---

## 8) Infos utiles

| Info | Valeur |
|------|--------|
| IP Hetzner | `88.198.149.117` |
| URL WSS | `wss://ws.server-kd.88-198-149-117.sslip.io` |
| Health check | `https://ws.server-kd.88-198-149-117.sslip.io/health` |
| Dossier serveur | `/opt/ws-media-stream-server` |
| Process PM2 | `ws-server-kd` (`id: 0`) |
| Repo | `github.com/kduflopro-arch/ws-media-stream-server` |
