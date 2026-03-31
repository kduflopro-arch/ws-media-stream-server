# Commandes — Console Hetzner (SSH direct sur le serveur)

> Connecte-toi d'abord via la console VNC Hetzner ou SSH :
> Login : `root` | Password : ton mot de passe root

---

## PM2 — Gestion du serveur WS

| Commande | Rôle |
|----------|------|
| `pm2 status` | Voir l'état de tous les processus (nom, statut, CPU, RAM, redémarrages) |
| `pm2 logs ws-server-kd` | Voir les logs en **temps réel** (Ctrl+C pour quitter) |
| `pm2 logs ws-server-kd --lines 50` | Voir les 50 dernières lignes de logs |
| `pm2 logs ws-server-kd --nostream` | Voir les logs sans suivre en direct |
| `pm2 flush ws-server-kd` | Vider / effacer tous les logs |
| `pm2 restart ws-server-kd` | Redémarrer le serveur (après une modif manuelle) |
| `pm2 stop ws-server-kd` | Arrêter le serveur |
| `pm2 start ws-server-kd` | Démarrer le serveur (s'il est arrêté) |
| `pm2 delete ws-server-kd` | Supprimer le processus de PM2 |
| `pm2 reload ws-server-kd` | Redémarrer sans interruption (0 downtime) |
| `pm2 monit` | Dashboard temps réel CPU/RAM/logs interactif |
| `pm2 save` | Sauvegarder la liste des processus (pour le reboot) |
| `pm2 resurrect` | Restaurer les processus sauvegardés après un reboot |

---

## Fichiers & Répertoire du projet

| Commande | Rôle |
|----------|------|
| `cd /opt/ws-media-stream-server` | Aller dans le dossier du projet |
| `ls -la` | Lister tous les fichiers (y compris cachés) |
| `cat .env` | Voir le contenu du fichier .env |
| `nano .env` | Modifier le fichier .env (Ctrl+X pour quitter, Y pour sauvegarder) |
| `cat ecosystem.config.cjs` | Voir la config PM2 |
| `cat server_restaurant.js` | Voir le fichier d'entrée du serveur restaurant |

---

## Git — Mise à jour manuelle du code

| Commande | Rôle |
|----------|------|
| `cd /opt/ws-media-stream-server` | Aller dans le projet |
| `git status` | Voir les fichiers modifiés localement |
| `git pull origin main` | Récupérer la dernière version depuis GitHub |
| `git log --oneline -10` | Voir les 10 derniers commits |
| `git diff` | Voir les modifications en cours |

---

## Nginx — Serveur web / Reverse proxy

| Commande | Rôle |
|----------|------|
| `systemctl status nginx` | Voir si Nginx fonctionne |
| `systemctl restart nginx` | Redémarrer Nginx |
| `systemctl reload nginx` | Recharger la config sans couper les connexions |
| `nginx -t` | Tester la configuration Nginx (erreurs de syntaxe) |
| `cat /etc/nginx/sites-available/ws-autoguru` | Voir la config du site |
| `nano /etc/nginx/sites-available/ws-autoguru` | Modifier la config Nginx |

---

## SSL / Certificat Let's Encrypt

| Commande | Rôle |
|----------|------|
| `certbot renew --dry-run` | Tester le renouvellement SSL sans l'appliquer |
| `certbot renew` | Renouveler le certificat SSL manuellement |
| `certbot certificates` | Voir les certificats installés et leur date d'expiration |

---

## Firewall (UFW)

| Commande | Rôle |
|----------|------|
| `ufw status` | Voir les règles actives |
| `ufw allow 80` | Ouvrir le port HTTP |
| `ufw allow 443` | Ouvrir le port HTTPS/WSS |
| `ufw allow 22` | Ouvrir le port SSH (ne jamais fermer) |
| `ufw deny 8080` | Bloquer l'accès direct au port 8080 (sécurité) |

---

## Système

| Commande | Rôle |
|----------|------|
| `htop` | Voir CPU, RAM, processus en temps réel (q pour quitter) |
| `df -h` | Voir l'espace disque disponible |
| `free -h` | Voir la RAM disponible |
| `uptime` | Voir depuis combien de temps le serveur tourne |
| `reboot` | Redémarrer le serveur |
| `curl https://ws.server-kd.sslip.io/health` | Vérifier que le serveur répond bien |

---

## Scénarios courants

### Le serveur ne répond plus
```bash
pm2 status
pm2 restart ws-server-kd
```

### Voir ce qui se passe pendant un appel
```bash
pm2 logs ws-server-kd
# Passe un appel → tu vois les logs en direct
```

### Mettre à jour le .env (nouvelle variable)
```bash
cd /opt/ws-media-stream-server
nano .env
# Modifie la variable, sauvegarde
pm2 restart ws-server-kd
```

### Vérifier que le SSL est toujours valide
```bash
certbot certificates
```

### Redémarrage complet du serveur
```bash
reboot
# Après redémarrage, PM2 relance ws-server-kd automatiquement
# Vérifie avec : pm2 status
```
