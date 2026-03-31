# Commandes — Depuis ton Mac

> Tout se fait depuis le Terminal de ton Mac, sans avoir besoin d'ouvrir la console Hetzner.

---

## Connexion SSH au serveur

| Commande | Rôle |
|----------|------|
| `ssh root@88.198.149.117` | Se connecter au serveur Hetzner |
| `exit` | Se déconnecter du serveur |
| `ssh root@88.198.149.117 "pm2 status"` | Exécuter une commande sur le serveur sans s'y connecter |

---

## Voir les logs en direct (sans se connecter manuellement)

```bash
ssh root@88.198.149.117 "pm2 logs ws-server-kd"
```
> Affiche les logs en temps réel depuis ton Mac. Ctrl+C pour arrêter.

---

## Envoyer des fichiers sur le serveur (scp)

| Commande | Rôle |
|----------|------|
| `scp fichier.txt root@88.198.149.117:/opt/ws-media-stream-server/` | Envoyer un fichier sur le serveur |
| `scp /chemin/local/.env root@88.198.149.117:/opt/ws-media-stream-server/.env` | Mettre à jour le .env |
| `scp -r /dossier/ root@88.198.149.117:/opt/ws-media-stream-server/` | Envoyer un dossier entier |

---

## Récupérer des fichiers depuis le serveur

| Commande | Rôle |
|----------|------|
| `scp root@88.198.149.117:/opt/ws-media-stream-server/.env ~/Downloads/` | Télécharger le .env sur ton Mac |
| `scp root@88.198.149.117:/root/.pm2/logs/ws-server-kd-out.log ~/Desktop/` | Télécharger les logs |

---

## Git — Déploiement du code

| Commande | Rôle |
|----------|------|
| `cd /Users/kendrikduflo/Documents/AutoGuru/ws-media-stream-server` | Aller dans le projet WS |
| `git status` | Voir les fichiers modifiés |
| `git add .` | Ajouter tous les fichiers modifiés |
| `git add fichier.js` | Ajouter un fichier spécifique |
| `git commit -m "description"` | Créer un commit |
| `git push origin main` | Pousser sur GitHub → **déclenche le déploiement automatique sur Hetzner** |
| `git log --oneline -10` | Voir les 10 derniers commits |

---

## Vérifier que le serveur fonctionne

| Commande | Rôle |
|----------|------|
| `curl https://ws.88-198-149-117.sslip.io/health` | Vérifier que le serveur répond (`ok` = tout va bien) |
| `curl -I https://ws.88-198-149-117.sslip.io` | Voir les headers HTTP (vérifier SSL) |

---

## Gérer PM2 à distance (sans se connecter)

| Commande | Rôle |
|----------|------|
| `ssh root@88.198.149.117 "pm2 status"` | Voir l'état du serveur |
| `ssh root@88.198.149.117 "pm2 restart ws-server-kd"` | Redémarrer le serveur |
| `ssh root@88.198.149.117 "pm2 logs ws-server-kd --lines 30 --nostream"` | Voir les 30 dernières lignes de logs |
| `ssh root@88.198.149.117 "pm2 flush ws-server-kd"` | Vider les logs |

---

## Mettre à jour le .env depuis ton Mac

```bash
# 1. Modifie ton .env local
nano /Users/kendrikduflo/Documents/AutoGuru/ws-media-stream-server/.env

# 2. Envoie-le sur le serveur
scp /Users/kendrikduflo/Documents/AutoGuru/ws-media-stream-server/.env root@88.198.149.117:/opt/ws-media-stream-server/.env

# 3. Redémarre le serveur pour prendre en compte les nouvelles variables
ssh root@88.198.149.117 "pm2 restart ws-server-kd"
```

---

## Vercel — Gérer les variables d'environnement

| Commande | Rôle |
|----------|------|
| `cd /Users/kendrikduflo/Documents/AutoGuru/autoguru-ai` | Aller dans le projet Next.js |
| `npx vercel env ls` | Voir toutes les variables d'environnement Vercel |
| `npx vercel env add NOM_VARIABLE production` | Ajouter une variable (te demande la valeur) |
| `npx vercel env rm NOM_VARIABLE` | Supprimer une variable |
| `npx vercel --prod` | Redéployer en production |

---

## Scénarios courants depuis le Mac

### Déployer une mise à jour
```bash
cd /Users/kendrikduflo/Documents/AutoGuru/ws-media-stream-server
git add .
git commit -m "description de la modif"
git push origin main
# → GitHub Actions déploie automatiquement sur Hetzner
```

### Vérifier que le déploiement s'est bien passé
```bash
# 1. Aller sur github.com/kduflopro-arch/ws-media-stream-server → onglet Actions
# 2. Ou vérifier les logs directement :
ssh root@88.198.149.117 "pm2 logs ws-server-kd --lines 20 --nostream"
```

### Le serveur ne répond plus
```bash
curl https://ws.88-198-149-117.sslip.io/health
# Si pas de réponse :
ssh root@88.198.149.117 "pm2 restart ws-server-kd"
```

### Ajouter une variable d'environnement
```bash
# Sur Hetzner (WS server) :
scp .env root@88.198.149.117:/opt/ws-media-stream-server/.env
ssh root@88.198.149.117 "pm2 restart ws-server-kd"

# Sur Vercel (Next.js) :
cd /Users/kendrikduflo/Documents/AutoGuru/autoguru-ai
npx vercel env add NOM_VARIABLE production
npx vercel --prod
```

---

## Infos serveur

| Info | Valeur |
|------|--------|
| **IP Hetzner** | `88.198.149.117` |
| **URL WSS** | `wss://ws.88-198-149-117.sslip.io` |
| **Health check** | `https://ws.88-198-149-117.sslip.io/health` |
| **Dossier projet** | `/opt/ws-media-stream-server` |
| **Process PM2** | `ws-server-kd` |
| **Repo GitHub** | `github.com/kduflopro-arch/ws-media-stream-server` |
