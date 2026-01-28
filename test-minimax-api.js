// Script de test pour l'API Minimax TTS
// Usage: MINIMAX_API_KEY=xxx MINIMAX_GROUP_ID=yyy node test-minimax-api.js
// Clé provisoire : à révoquer après le test sur platform.minimax.io

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID;
const MINIMAX_VOICE_ID = process.env.MINIMAX_VOICE_ID || "French_Female_News Anchor";

async function testMinimaxAPI() {
  console.log("🧪 Test API Minimax TTS\n");

  if (!MINIMAX_API_KEY || !MINIMAX_GROUP_ID) {
    console.error("❌ Définissez MINIMAX_API_KEY et MINIMAX_GROUP_ID (clé provisoire, à révoquer après le test).");
    console.error("   Exemple: MINIMAX_API_KEY=sk-... MINIMAX_GROUP_ID=... node test-minimax-api.js");
    process.exit(1);
  }

  console.log("Configuration:");
  console.log("  MINIMAX_API_KEY:", MINIMAX_API_KEY.substring(0, 20) + "...");
  console.log("  MINIMAX_GROUP_ID:", MINIMAX_GROUP_ID);
  console.log("  MINIMAX_VOICE_ID:", MINIMAX_VOICE_ID);
  console.log("");

  const testText = "Bonjour, ceci est un test de synthèse vocale.";
  
  // Test 1: Format Bearer
  console.log("📡 Test 1: Format Bearer");
  await testFormat(`Bearer ${MINIMAX_API_KEY}`, "Bearer", testText);

  // Test 2: Format direct (sans Bearer)
  console.log("\n📡 Test 2: Format direct (sans Bearer)");
  await testFormat(MINIMAX_API_KEY, "Direct", testText);

  // Test 3: Format X-API-Key header
  console.log("\n📡 Test 3: Format X-API-Key header");
  await testFormatXApiKey(MINIMAX_API_KEY, testText);
  
  // Test 4: Format avec API secret (peut-être différent de la clé API)
  console.log("\n📡 Test 4: Format avec clé dans body (si supporté)");
  await testFormatInBody(MINIMAX_API_KEY, testText);
}

async function testFormatInBody(apiKey, testText) {
  try {
    const url = `https://api.minimax.chat/v1/text_to_speech?GroupId=${encodeURIComponent(MINIMAX_GROUP_ID)}`;
    
    console.log(`  URL: ${url}`);
    console.log(`  Authorization: Bearer ${apiKey.substring(0, 30)}...`);
    console.log(`  Body contient aussi api_key`);
    
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json, application/octet-stream, audio/*",
      },
      body: JSON.stringify({
        text: testText,
        voice_id: MINIMAX_VOICE_ID,
        model: "speech-01",
        speed: 1.0,
        volume: 1.0,
        pitch: 0,
        audio_type: "pcm16",
        sample_rate: 8000,
        api_key: apiKey, // Essayer aussi dans le body
      }),
    });

    const contentType = resp.headers.get("content-type") || "";
    const respText = await resp.text();
    
    console.log(`  Status: ${resp.status} ${resp.statusText}`);
    console.log(`  Content-Type: ${contentType}`);
    console.log(`  Réponse (premiers 200 chars): ${respText.substring(0, 200)}`);

    if (resp.ok && contentType.includes("application/json")) {
      try {
        const json = JSON.parse(respText);
        if (json.base_resp) {
          if (json.base_resp.status_code === 0) {
            console.log(`  ✅ Body avec api_key: SUCCÈS !`);
            return true;
          } else {
            console.log(`  ❌ Body avec api_key: Erreur - ${json.base_resp.status_msg} (code: ${json.base_resp.status_code})`);
          }
        }
      } catch (e) {
        // Pas JSON
      }
    }
  } catch (error) {
    console.error(`  ❌ Body avec api_key: Exception -`, error.message);
  }
  return false;
}

async function testFormat(authValue, formatName, testText) {
  // Tester différents hôtes Minimax
  const hosts = [
    "https://api.minimax.chat",
    "https://api.minimax.io",
    "https://api.minimaxi.com",
  ];
  
  for (const host of hosts) {
    try {
      const groupIdParam = MINIMAX_GROUP_ID ? `?GroupId=${encodeURIComponent(MINIMAX_GROUP_ID)}` : "";
      const url = `${host}/v1/text_to_speech${groupIdParam}`;
      
      console.log(`  Test hôte: ${host}`);
      console.log(`  URL: ${url}`);
      console.log(`  Authorization: ${authValue.substring(0, 30)}...`);
      
      const body = {
        text: testText,
        voice_id: MINIMAX_VOICE_ID,
        model: "speech-01",
        speed: 1.0,
        volume: 1.0,
        pitch: 0,
        audio_type: "pcm16",
        sample_rate: 8000,
      };
      
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authValue,
          "Accept": "application/json, application/octet-stream, audio/*",
        },
        body: JSON.stringify(body),
      });

      const contentType = resp.headers.get("content-type") || "";
      const respText = await resp.text();
      
      console.log(`  Status: ${resp.status} ${resp.statusText}`);
      console.log(`  Content-Type: ${contentType}`);
      console.log(`  Content-Length: ${resp.headers.get("content-length") || "N/A"}`);
      console.log(`  Réponse (premiers 200 chars): ${respText.substring(0, 200)}`);

      if (resp.ok && contentType.includes("application/json")) {
        try {
          const json = JSON.parse(respText);
          if (json.base_resp) {
            if (json.base_resp.status_code === 0) {
              console.log(`  ✅ ${formatName} (${host}): SUCCÈS !`);
              console.log(`  Champs disponibles: ${Object.keys(json).join(", ")}`);
              if (json.audio || json.data || json.content) {
                console.log(`  ✅ Audio trouvé dans: ${json.audio ? "audio" : json.data ? "data" : "content"}`);
              }
              return true;
            } else {
              console.log(`  ❌ ${formatName} (${host}): Erreur - ${json.base_resp.status_msg} (code: ${json.base_resp.status_code})`);
              // Si ce n'est pas "invalid api key" ou "login fail", continuer avec le prochain hôte
              if (json.base_resp.status_code !== 2049 && json.base_resp.status_code !== 1004) {
                continue;
              }
            }
          } else {
            console.log(`  ✅ ${formatName} (${host}): Réponse JSON sans base_resp`);
            console.log(`  Champs: ${Object.keys(json).join(", ")}`);
            return true;
          }
        } catch (e) {
          console.log(`  ⚠️ ${formatName} (${host}): Réponse non-JSON`);
        }
      } else if (resp.ok && !contentType.includes("application/json")) {
        console.log(`  ✅ ${formatName} (${host}): Réponse binaire (${respText.length} bytes)`);
        return true;
      } else {
        console.log(`  ❌ ${formatName} (${host}): Erreur HTTP ${resp.status}`);
      }
    } catch (error) {
      console.error(`  ❌ ${formatName} (${host}): Exception -`, error.message);
    }
  }
  return false;
}

async function testFormatXApiKey(apiKey, testText) {
  try {
    const url = `https://api.minimax.chat/v1/text_to_speech?GroupId=${encodeURIComponent(MINIMAX_GROUP_ID)}`;
    
    console.log(`  URL: ${url}`);
    console.log(`  X-API-Key: ${apiKey.substring(0, 30)}...`);
    
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "Accept": "application/json, application/octet-stream, audio/*",
      },
      body: JSON.stringify({
        text: testText,
        voice_id: MINIMAX_VOICE_ID,
        model: "speech-01",
        speed: 1.0,
        volume: 1.0,
        pitch: 0,
        audio_type: "pcm16",
        sample_rate: 8000,
      }),
    });

    const contentType = resp.headers.get("content-type") || "";
    const respText = await resp.text();
    
    console.log(`  Status: ${resp.status} ${resp.statusText}`);
    console.log(`  Content-Type: ${contentType}`);
    console.log(`  Réponse (premiers 200 chars): ${respText.substring(0, 200)}`);

    if (resp.ok && contentType.includes("application/json")) {
      try {
        const json = JSON.parse(respText);
        if (json.base_resp) {
          if (json.base_resp.status_code === 0) {
            console.log(`  ✅ X-API-Key: SUCCÈS !`);
            return true;
          } else {
            console.log(`  ❌ X-API-Key: Erreur - ${json.base_resp.status_msg} (code: ${json.base_resp.status_code})`);
          }
        }
      } catch (e) {
        // Pas JSON
      }
    }
    
    if (resp.ok && !contentType.includes("application/json")) {
      console.log(`  ✅ X-API-Key: Réponse binaire (${respText.length} bytes)`);
      return true;
    } else {
      console.log(`  ❌ X-API-Key: Erreur HTTP ${resp.status}`);
    }
  } catch (error) {
    console.error(`  ❌ X-API-Key: Exception -`, error.message);
  }
  return false;
}

// Lancer les tests
testMinimaxAPI().catch(console.error);
