# Audit : tout ce qui est envoyé à OpenAI GPT Realtime

Objectif : identifier ce qui est **nécessaire** au bon fonctionnement d’AutoGuru et du serveur WS, et ce qui peut être **réduit ou supprimé** pour limiter les erreurs de rate limit (TPM = tokens par minute).

---

## 1. Ce qui est envoyé à l’API OpenAI

### 1.1 `session.update` (une fois au démarrage + une fois après réception des infos client)

**Contenu :**
- `session.type`: `"realtime"`
- `session.instructions`: **texte complet du prompt système** (très long, voir ci‑dessous)
- `session.output_modalities`: `["text"]`
- Optionnel : `session.input_audio_transcription` (désactivé par défaut, non supporté sur le modèle actuel)

**Taille typique :** ~36 000 caractères (≈ 9 000–12 000 tokens) selon les logs (`promptLength: 36717`).

---

### 1.2 Contenu de `instructions` (détail)

Le prompt est construit ainsi :

| Bloc | Contenu | Nécessaire AutoGuru/WS ? | Réductible ? |
|------|---------|---------------------------|--------------|
| **baseInstructions** | Rôle, règles d’écoute, objectif, mode RDV, consentement, horaires, tarifs, services, FAQs, **section client (buildClientInfoLine)**, règles RDV, diagnostic, intention RDV, style. | **Oui** (cœur métier) | Oui : doublons et exemples répétés |
| **mechanicPersona** OU **neutralPersona** | Persona + (si mecanicien) **base de connaissances mécaniques** + méthode d’écoute + checklist + règles compréhension + infos à collecter pour rappel. | Persona + méthode : **oui**. Encyclopédie mécanique : **non** pour le flux minimal. | **Oui** : encyclopédie très longue |
| **variationGuidelines** | Varier formulations, "Bonjour"/"Salut"/"Oui allô". | Optionnel (qualité) | Oui (4 lignes, faible gain) |
| **hardConstraints** | Garage auto uniquement, plaque, procédure RDV, tarifs, pas de modèle véhicule. | **Oui** | Peu |
| **closingGuidelines** | Fin d’appel, numéro à l’accueil, garage fermé. | **Oui** | Non |

---

### 1.3 Encyclopédie mécanique (`mechanicalKnowledgePrompt`)

**Contenu :** ~150 lignes :
- Liste des systèmes du véhicule (moteur, électrique, freinage, suspension, transmission, clim, pneus)
- Codes OBD-II (P0xxx, P1xxx, P2xxx, P3xxx, C0xxx, B0xxx, U0xxx)
- Problèmes courants avec causes et questions à poser (moteur qui tousse, surchauffe, ne démarre pas, perte de puissance, freinage, suspension, électrique, clim, échappement)
- Règles de diagnostic, niveaux d’urgence, vocabulaire technique

**Nécessaire au bon fonctionnement ?**  
**Non.** Pour le flux AutoGuru (comprendre le besoin → 1–2 questions → proposer diagnostic + RDV), une version **très raccourcie** (problèmes courants en 1 phrase chacun + ordre des questions) suffit. L’encyclopédie complète fait monter fortement le TPM.

**Recommandation :** utiliser une version **courte** par défaut (ou activable via `TRIM_PROMPT_FOR_RATE_LIMIT=true`).

---

### 1.4 Doublons dans le prompt

Les mêmes règles apparaissent **plusieurs fois** dans `baseInstructions` et dans `mechanicPersona` / blocs suivants :

- "Pose une question après avoir mentionné des causes possibles" (RÈGLE CRITIQUE + RÈGLE ABSOLUE + DIAGNOSTIC GUIDÉ + exemples)
- "Ordre : jour → créneau (matin/après-midi) → plaque"
- "Avez-vous besoin d'autre chose ?" avant au revoir
- "Ok/d'accord seul = pas acceptation RDV"
- Exemples batterie/alternateur (INTERDIT / CORRECT) répétés 4–5 fois

**Nécessaire ?** Une seule formulation claire par règle suffit.  
**Réductible ?** **Oui** : garder une seule occurrence par règle et 1–2 exemples.

---

### 1.5 `conversation.item.create` (messages injectés)

| Contexte | Texte envoyé | Nécessaire ? |
|----------|--------------|--------------|
| Plaque reçue par SMS | `Plaque reçue par SMS: ${plate}. Continue la conversation.` | **Oui** si fonctionnalité SMS plaque utilisée |
| Fin d’échange (au revoir) | `Au revoir` (pour que l’IA réponde par un message de fin) | **Oui** (flux de fin d’appel) |

---

### 1.6 `input_audio_buffer.append` + `input_audio_buffer.commit`

Audio PCM reçu de Twilio, converti et envoyé à OpenAI pour la transcription (STT).

**Nécessaire ?** **Oui** : entrée client pour la conversation.

---

### 1.7 `response.create`

Demande à OpenAI de générer la réponse suivante (texte). Déclenché après un `commit` utilisateur ou après injection d’un message (ex. "Au revoir").

**Nécessaire ?** **Oui** : cœur du flux Realtime.

---

## 2. Ce qui n’est PAS envoyé à OpenAI

- Les appels **`fetch('http://127.0.0.1:7242/ingest/...')`** : logs / agent ingest, **pas d’envoi à OpenAI**, aucun impact sur le rate limit.
- Les paramètres Twilio (customParameters, garageId, etc.) : utilisés côté serveur pour construire le prompt et la config, pas envoyés tels quels à l’API OpenAI.

---

## 3. Synthèse : nécessaire vs réductible

### À conserver pour le bon fonctionnement

- **session.update** avec :
  - Rôle, objectif, mode RDV, consentement, horaires, tarifs, services, FAQs.
  - Section client (buildClientInfoLine) : détection client, plaque, RDV à venir, interdiction plaque, salutation, ordre jour → créneau → plaque.
  - Règles RDV et diagnostic (une version concise sans répétition).
  - Contraintes fortes (hardConstraints) et closingGuidelines.
- **Persona** : ton garage, écoute active, méthode (1 question à la fois, reformuler), infos à collecter pour le rappel.
- **conversation.item.create** pour SMS plaque et au revoir.
- **input_audio_buffer** + **response.create**.

### Réductible pour limiter le rate limit

1. ~~**Encyclopédie mécanique**~~ : **supprimée** (gain ~2 000–2 500 tokens par requête).
2. **Doublons de règles** : une seule formulation par règle (question après causes, ordre jour/créneau/plaque, "besoin d'autre chose", ok ≠ RDV). **Gain estimé : ~500–1 500 tokens.**
3. **Exemples répétés** : garder 1 EXEMPLE INTERDIT et 1 EXEMPLE CORRECT pour "cause + question", supprimer les autres. **Gain estimé : ~200–500 tokens.**
4. **variationGuidelines** : optionnel ; les supprimer ne casse pas le flux. **Gain faible.**

---

## 4. Variable d’environnement proposée

- **`TRIM_PROMPT_FOR_RATE_LIMIT=true`**  
  Quand activée : utilisation d’une version **courte** de la base de connaissances mécaniques (sans la liste détaillée OBD-II ni les paragraphes longs par problème), et suppression des blocs de règles dupliquées dans le prompt.

Cela réduit la taille de `instructions` envoyée à chaque `session.update` (et donc le TPM consommé à chaque tour).
