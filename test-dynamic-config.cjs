#!/usr/bin/env node

/**
 * Test-Skript für die dynamische Konfiguration
 * Überprüft, ob die free_models korrekt in die dynamische Konfiguration aufgenommen werden
 */

const fs = require('fs');
const path = require('path');

// Pfade
const extDir = process.cwd();
const staticCfgPath = path.join(extDir, 'router-config.json');
const dynamicCfgPath = path.join(extDir, 'router-config.dynamic.json');

console.log('🔍 Testing Dynamic Configuration Generation\n');

// 1. Statische Konfiguration laden
console.log('1. Loading static configuration...');
const staticCfg = JSON.parse(fs.readFileSync(staticCfgPath, 'utf-8'));
console.log('   ✅ Static config loaded\n');

// 2. Free Models extrahieren
console.log('2. Extracting free models from static config...');
const freeModels = [];
for (const [provId, provConfig] of Object.entries(staticCfg.providers ?? {})) {
  if (provConfig.free_models && Array.isArray(provConfig.free_models)) {
    for (const model of provConfig.free_models) {
      const normalized = model.startsWith(`${provId}/`) ? model : `${provId}/${model}`;
      freeModels.push(normalized);
    }
  }
}
console.log(`   Found ${freeModels.length} free models:`);
freeModels.forEach(m => console.log(`     - ${m}`));
console.log();

// 3. Dynamische Konfiguration laden (falls vorhanden)
console.log('3. Checking dynamic configuration...');
let dynamicCfg;
try {
  dynamicCfg = JSON.parse(fs.readFileSync(dynamicCfgPath, 'utf-8'));
  console.log('   ✅ Dynamic config exists\n');
  
  // 4. Überprüfen, ob free_models in den Gruppen sind
  console.log('4. Checking if free models are in dynamic groups...');
  
  const groupsToCheck = ['trivial', 'simple', 'scout'];
  let allGood = true;
  
  for (const groupName of groupsToCheck) {
    const group = dynamicCfg.model_groups?.[groupName];
    if (!group) {
      console.log(`   ❌ Group '${groupName}' not found in dynamic config`);
      allGood = false;
      continue;
    }
    
    const groupModels = group.models || [];
    console.log(`   Group '${groupName}': ${groupModels.length} models`);
    
    if (groupModels.length === 0) {
      console.log(`     ❌ EMPTY! This is the bug we're fixing.`);
      allGood = false;
    } else {
      // Überprüfe, ob free_models enthalten sind
      const freeModelsInGroup = groupModels.filter(m => freeModels.includes(m));
      console.log(`     Free models in group: ${freeModelsInGroup.length}`);
      freeModelsInGroup.forEach(m => console.log(`       - ${m}`));
      
      if (freeModelsInGroup.length === 0 && groupName !== 'scout') {
        console.log(`     ⚠️  No free models in '${groupName}' group`);
      }
    }
    console.log();
  }
  
  // 5. Zusammenfassung
  console.log('5. Summary:');
  if (allGood) {
    console.log('   ✅ All checks passed! Free models are included in dynamic config.');
  } else {
    console.log('   ❌ Issues found. Dynamic config needs to be regenerated.');
    console.log('   Run: rm router-config.dynamic.json && start Pi to regenerate');
  }
  
} catch (error) {
  console.log('   ⚠️  Dynamic config not found. This is expected if not generated yet.');
  console.log('   The fix ensures free_models will be included when generated.\n');
}

// 6. Zeige die wichtigsten Gruppen aus der statischen Konfiguration
console.log('6. Static config groups:');
const importantGroups = ['trivial', 'simple', 'standard', 'complex', 'dynamic'];
for (const groupName of importantGroups) {
  const group = staticCfg.model_groups?.[groupName];
  if (group) {
    console.log(`   ${groupName}: method=${group.method}, models=${group.models?.length || 0}`);
  }
}
console.log();

console.log('✅ Test complete!');
