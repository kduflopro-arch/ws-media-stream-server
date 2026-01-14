# Résultats des tests API Minimax

## Tests effectués

### Hôtes testés
- `https://api.minimax.chat` → "invalid api key" (code 2049)
- `https://api.minimax.io` → "rate limit exceeded(RPM)" (code 1002) ✅ **Hôte correct !**
- `https://api.minimaxi.com` → "invalid api key" (code 2049)

### Formats d'authentification testés
1. **Bearer** : `Authorization: Bearer sk-api-...`
   - Résultat : "invalid api key" sur .chat et .com
   - Résultat : "rate limit exceeded" sur .io (✅ clé valide mais rate limit)

2. **Direct** : `Authorization: sk-api-...` (sans Bearer)
   - Résultat : "Please carry the API secret key in the 'Authorization' field"

3. **X-API-Key** : Header `X-API-Key: sk-api-...`
   - Résultat : "Please carry the API secret key in the 'Authorization' field"

## Conclusion

✅ **Hôte correct** : `https://api.minimax.io`
✅ **Format correct** : `Authorization: Bearer sk-api-...`
⚠️ **Rate limit** : La clé API fonctionne mais le compte a peut-être un rate limit bas

## Configuration à utiliser dans Render

```bash
MINIMAX_API_KEY=sk-api-NCjZ4fIrTdtt89LRJU_A8GgYdnKp9oUizFriZeQy6nhEGKujfk3A8HH7k0F066vImomK_SKIrPIVpnVPPXBIeYsOBAJu_Zg_CqnHh5vZ1t3pEjdsku5Zt-g
MINIMAX_GROUP_ID=2011503273374126308
MINIMAX_VOICE_ID=French_Female_News Anchor
```

## Note sur le rate limit

Si vous obtenez "rate limit exceeded", cela signifie que :
- La clé API est valide ✅
- Le format d'authentification est correct ✅
- Mais le compte a atteint sa limite de requêtes par minute

Solution : Attendre quelques secondes entre les appels, ou vérifier les limites de votre compte Minimax.
