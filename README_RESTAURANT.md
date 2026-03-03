# Serveur WebSocket Restaurant

Secteur d'activité **restaurant** : un serveur WS dédié gère les appels des comptes restaurant, totalement séparé du serveur garage.

## Architecture

- **server.js** : point d'entrée GARAGE uniquement → charge server-core.js avec SECTOR=garage
- **server_restaurant.js** : point d'entrée RESTAURANT uniquement → charge server-core.js avec SECTOR=restaurant
- **server-core.js** : logique partagée (WebSocket, TTS, IA). SECTOR définit les salutations et outils.

Un appel garage utilise **jamais** server_restaurant.js. Un appel restaurant utilise **jamais** server.js. Chaque service Render exécute un seul fichier.

## Déploiement Render (2 services)

1. **Service 1 – Garage**  
   - Build Command : `npm install`  
   - Start Command : `npm run start` (ou `node server.js`)  
   - URL : `wss://ws-garage.onrender.com` (exemple)

2. **Service 2 – Restaurant**  
   - Build Command : `npm install`  
   - Start Command : `npm run start:restaurant` (ou `node server_restaurant.js`)  
   - URL : `wss://ws-restaurant.onrender.com` (exemple)

## Variables d'environnement Vercel

- `WS_MEDIA_STREAM_URL_RESTAURANT` : URL du serveur WS restaurant (ex. `wss://ws-restaurant.onrender.com`)  
  Si définie, les appels des comptes restaurant sont routés vers cette URL.

## Base de données

Migration `0049_add_garage_type_restaurant.sql` :

- `garages.type` : `'garage'` (par défaut) ou `'restaurant'`
- Pour un compte restaurant : `UPDATE autoguru.garages SET type = 'restaurant' WHERE id = '...';`

## Comportement IA Restaurant

- Détection : réservation, information, modification, annulation
- Multilingue : adaptation automatique à la langue du client
- Réservation : nom, confirmation du numéro, second numéro optionnel, nombre de personnes, heure souhaitée, etc.
- Conversation naturelle, style humain
