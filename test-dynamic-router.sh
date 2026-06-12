#!/bin/bash
# Testskript für den dynamic-Modus des pi-model-routers

# 1. Ollama starten (falls nicht läuft)
if ! pgrep -f "ollama serve" > /dev/null; then
  echo "🔥 Starte Ollama (erforderlich für die Klassifizierung)..."
  ollama serve > /dev/null 2>&1 &
  sleep 5  # Warte auf Ollama-Start
fi

# 2. Modell laden (falls nicht vorhanden)
if ! ollama list | grep -q "gemma2:2b"; then
  echo "📥 Lade gemma2:2b für die Klassifizierung..."
  ollama pull gemma2:2b > /dev/null
fi

# 3. PI-Session starten und Testdurchlauf
echo "🧪 Teste den dynamic-Modus mit Beispiel-Prompts:"

# Test 1: Design-Prompt (sollte 'strategic' auswählen)
echo -e "\n--- Test 1: Design-Prompt ---"
pi --one-shot --command "/router dynamic" --prompt "Entwirf eine REST-API für ein Benutzerverwaltungssystem."

# Test 2: Code-Prompt (sollte 'operational' auswählen)
echo -e "\n--- Test 2: Code-Prompt ---"
pi --one-shot --command "/router dynamic" --prompt "Ersetze alle Vorkommen von 'oldVar' mit 'newVar' in dieser Datei."

# Test 3: Fallback (unspezifischer Prompt)
echo -e "\n--- Test 3: Fallback-Prompt ---"
pi --one-shot --command "/router dynamic" --prompt "Hilfe"

# 4. Gruppenstatus anzeigen
echo -e "\n--- Gruppenstatus ---"
pi --one-shot --command "/router"

# 5. Strategische Gruppe detailliert anzeigen
echo -e "\n--- Strategische Gruppe ---"
pi --one-shot --command "/router strategic"

echo -e "\n✅ Tests abgeschlossen. Prüfe die Konsolenausgabe auf:
- [dynamic] Logs für die Klassifizierung
- Auswahl der richtigen Gruppen (strategic/operational/fallback)"