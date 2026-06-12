// test-dynamic-api.mjs
// Testet den dynamic-Modus des pi-model-routers über die PI-API

import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

async function testDynamicRouter() {
  try {
    // PI-Instanz erstellen (simuliert die Extension-Umgebung)
    const pi = new ExtensionAPI();

    // 1. Router-Extension laden
    console.log("🔍 Lade pi-model-router...");
    const routerExt = await import("./dist/index.js");
    routerExt.default(pi);

    // 2. Dynamic-Modus testen
    console.log("\n--- Test 1: Design-Prompt ---");
    pi.hooks.before_user_prompt({
      prompt: "Entwirf eine REST-API für ein Benutzerverwaltungssystem.",
      context: { modelRegistry: pi.modelRegistry }
    });

    console.log("\n--- Test 2: Code-Prompt ---");
    pi.hooks.before_user_prompt({
      prompt: "Ersetze alle Vorkommen von 'oldVar' mit 'newVar' in dieser Datei.",
      context: { modelRegistry: pi.modelRegistry }
    });

    console.log("\n--- Test 3: Fallback-Prompt ---");
    pi.hooks.before_user_prompt({
      prompt: "Hilfe",
      context: { modelRegistry: pi.modelRegistry }
    });

    console.log("\n✅ Tests abgeschlossen. Prüfe die Konsolenausgabe auf [dynamic]-Logs.");
  } catch (error) {
    console.error("Fehler:", error);
  }
}

// Skript starten
testDynamicRouter();