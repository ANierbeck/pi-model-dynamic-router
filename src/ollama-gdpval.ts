// src/ollama-gdpval.ts
// Estimates GDPval scores for Ollama models based on model names and sizes.
//
// WHY: Ollama models are auto-discovered via /api/tags, but without GDPval
// scores they default to 50, making them eligible only for "scout" groups.
// This module provides reasonable estimates so Ollama models can compete in
// operational/tactical groups based on their actual capabilities.
//
// NOT merged with ollama-context.ts / ollama-utils.ts (F1 evaluation): this
// module is pure scoring math with no I/O, ollama-context.ts resolves
// context-window options from scan capabilities, and ollama-utils.ts wraps
// the live Ollama HTTP API. Different concerns, different consumers
// (index.ts, escalation.ts/content-classifier.ts) — merging would just move
// code around without shrinking the API surface.

/**
 * Known model families and their typical GDPval ranges.
 * Based on empirical benchmarks and model capabilities.
 */
const MODEL_FAMILY_SCORES: Record<string, number> = {
  // Qwen family
  'qwen': 450,            // Qwen base models
  'qwen2': 450,           // Qwen2 base models
  'qwen3': 500,           // Qwen3 base models  
  'qwen3.5': 550,         // Qwen3.5 models
  'qwen3.8': 580,         // Qwen3.8 models (our new addition)
  'qwen4': 600,           // Future Qwen4 models
  
  // Gemma family
  'gemma': 400,           // Gemma base models
  'gemma2': 400,          // Gemma 2 models
  'gemma3': 450,          // Gemma 3 models
  'gemma4': 500,          // Gemma 4 models
  
  // Llama family
  'llama2': 350,          // Llama 2 models
  'llama3': 450,          // Llama 3 models
  'llama3.1': 480,        // Llama 3.1 models
  'llama3.2': 500,        // Llama 3.2 models
  'llama4': 550,          // Future Llama 4 models
  
  // Mistral family
  'mistral': 600,         // Mistral base models
  'mistral-small': 450,   // Mistral Small models
  'mistral-medium': 650,  // Mistral Medium models
  'mistral-large': 750,   // Mistral Large models
  
  // Code-specific models (lower scores as they're specialized)
  'codellama': 400,
  'codeqwen': 420,
  'deepseek-coder': 450,
  'starcoder2': 430,
  
  // Other notable models
  'phi3': 420,            // Phi-3 models
  'phi4': 480,            // Future Phi-4 models
  'vicuna': 400,          // Vicuna models
  'orca': 420,            // Orca models
  'dolphin': 450,         // Dolphin models
  'stablelm': 380,        // StableLM models
  'falcon': 420,          // Falcon models
  'mixtral': 600,         // Mixtral models
  'openchat': 430,        // OpenChat models
  'solar': 450,           // Solar models
  'tinyllama': 350,       // TinyLlama models
  'minicpm': 400,         // MiniCPM models
  'qwen1.5': 400,         // Qwen 1.5 models
  'yi': 450,              // Yi models
  'deepseek': 480,        // DeepSeek models
  'glm': 450,             // GLM models
  'baichuan2': 420,       // Baichuan 2 models
  'internlm2': 430,       // InternLM 2 models
  'chatglm3': 440,        // ChatGLM 3 models
  'aquila2': 410,         // Aquila 2 models
};

// Substring matching below requires trying more specific family names first
// (e.g. 'qwen3.8' before 'qwen'), since a shorter generic key like 'qwen' is
// itself a substring of every versioned variant and would otherwise always
// win the match, making the specific scores unreachable.
const FAMILY_ENTRIES_BY_SPECIFICITY: [string, number][] = Object.entries(MODEL_FAMILY_SCORES).sort(
  ([a], [b]) => b.length - a.length,
);

/**
 * Size multipliers for models with explicit size indicators.
 * Larger models within the same family get higher scores.
 */
const SIZE_MULTIPLIERS: Record<string, number> = {
  '70b': 1.8,
  '65b': 1.7,
  '34b': 1.6,
  '33b': 1.6,
  '32b': 1.6,
  '30b': 1.5,
  '27b': 1.4,
  '20b': 1.3,
  '14b': 1.2,
  '13b': 1.2,
  '12b': 1.15,
  '9b': 1.1,
  '8b': 1.05,
  '7b': 1.0,
  '6b': 0.95,
  '5b': 0.9,
  '4b': 0.85,
  '3b': 0.8,
  '2b': 0.75,
  '1.5b': 0.7,
  '1b': 0.65,
  'mini': 0.7,
  'small': 0.8,
  'medium': 1.2,
  'large': 1.5,
};

/**
 * Quantization penalties. Quantized models are slightly less capable
 * than their full-precision counterparts.
 */
const QUANT_PENALTIES: Record<string, number> = {
  'q2_k': 0.95,
  'q3_k_s': 0.96,
  'q3_k_m': 0.97,
  'q3_k_l': 0.98,
  'q4_0': 0.98,
  'q4_k_s': 0.98,
  'q4_k_m': 0.99,
  'q5_0': 0.99,
  'q5_k_s': 0.99,
  'q5_k_m': 1.0,
  'q6_k': 1.0,
  'q8_0': 1.0,
  'gguf': 0.98,
  'ggml': 0.98,
  'awq': 0.97,
  'gptq': 0.96,
  'exl2': 0.99,
};

/**
 * Estimates GDPval score for an Ollama model based on its name.
 * @param modelName - The Ollama model name (e.g., "qwen3.8:27b-mlx")
 * @returns Estimated GDPval score, or null if no estimate can be made
 */
export function estimateOllamaGdpval(modelName: string): number | null {
  // Remove quantization/format suffixes first (e.g., "qwen3.8:27b-mlx-q4_k_m")
  let baseName = modelName;
  
  // Remove quantization suffixes
  for (const quant of Object.keys(QUANT_PENALTIES)) {
    if (baseName.endsWith(`-${quant}`)) {
      baseName = baseName.slice(0, -quant.length - 1);
      break;
    }
  }
  
  // Remove format suffixes (gguf, ggml, etc.)
  if (baseName.endsWith('-gguf') || baseName.endsWith('-ggml')) {
    baseName = baseName.slice(0, -5);
  }
  
  // Extract family and size
  let familyScore: number | null = null;
  let sizeMultiplier = 1.0;
  let quantPenalty = 1.0;
  
  // Normalize name: replace ':' and '_' separators with spaces. Hyphens are
  // deliberately kept as-is: several family keys use a hyphen themselves
  // (e.g. 'mistral-large', 'deepseek-coder'), so stripping it here would make
  // those substring matches permanently unreachable.
  const normalizedName = baseName.replace(/[:_]/g, ' ');
  
  // Find model family by checking if any family name appears in the normalized name
  for (const [family, score] of FAMILY_ENTRIES_BY_SPECIFICITY) {
    if (normalizedName.includes(family)) {
      familyScore = score;
      break;
    }
  }
  
  if (!familyScore) {
    return null; // No known family found
  }
  
  // Extract size information
  for (const [size, multiplier] of Object.entries(SIZE_MULTIPLIERS)) {
    if (baseName.includes(size)) {
      sizeMultiplier = multiplier;
      break;
    }
  }
  
  // Apply quantization penalty if we removed a quantization suffix
  if (modelName !== baseName) {
    for (const [quant, penalty] of Object.entries(QUANT_PENALTIES)) {
      if (modelName.includes(quant)) {
        quantPenalty = penalty;
        break;
      }
    }
  }
  
  // Calculate final score
  const estimatedScore = Math.round(familyScore * sizeMultiplier * quantPenalty);
  
  return estimatedScore;
}

/**
 * Derive a GDPval-style slug from an Ollama model name.
 * "qwen3.8:27b-mlx" → "qwen3-8-27b"
 * "gemma4:12b-mlx-q4_k_m" → "gemma4-12b"
 * Strips provider prefix, quantization/format suffixes, :tag suffixes, and
 * normalizes separators to dashes — matching how model-map.yaml slugs look.
 */
export function ollamaModelSlug(modelName: string): string {
  let s = modelName;
  // Strip the ollama provider prefix only ("ollama/...").
  // Other slashes are model namespaces (e.g. "PolyoxyDev/granite4-macos-micro")
  // and ARE part of the model identity — keep them.
  if (s.startsWith('ollama/')) s = s.slice('ollama/'.length);
  // Strip quantization suffixes (e.g. -q4_k_m, -f16)
  for (const quant of Object.keys(QUANT_PENALTIES)) {
    if (s.toLowerCase().endsWith(`-${quant}`)) {
      s = s.slice(0, -quant.length - 1);
      break;
    }
  }
  // Strip format suffixes
  if (s.endsWith('-gguf') || s.endsWith('-ggml')) s = s.slice(0, -5);
  // Strip :tag and -tag suffixes (e.g. :latest, :mlx, :cloud, -mlx, :instruct)
  // These are Ollama format tags, NOT part of the GDPval slug. Keep size tags
  // like :12b, :7b which ARE part of the slug.
  s = s.replace(/[-:](?:latest|mlx|cloud|instruct|chat|thinking|reasoning)$/i, '');
  // Strip -latest/-preview suffixes
  s = s.replace(/-(?:latest|preview)$/i, '');
  // Strip date suffixes (e.g. -2512, -2604)
  s = s.replace(/-(?:\d{4}|\d{6}|\d{8})$/, '');
  // Normalize separators: . : _ → -
  s = s.replace(/[.:_]/g, '-');
  // Collapse multiple dashes and trim
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s.toLowerCase();
}

/**
 * Estimates GDPval for all discovered Ollama models and returns a mapping
 * of GDPval-SLUG → score (compatible with cache.gdpval_scores, which the
 * lookup pipeline consumes as slug keys — NOT raw "ollama/<id>" refs).
 * This is the only batch estimator — always wire scores into the cache as
 * slugs, never as raw model names.
 */
export function estimateOllamaModelsGdpvalAsSlugs(ollamaModels: string[]): Record<string, number> {
  const estimates: Record<string, number> = {};
  for (const model of ollamaModels) {
    const score = estimateOllamaGdpval(model);
    if (score !== null) {
      const slug = ollamaModelSlug(model);
      // Don't overwrite a score already present (e.g. from model-map.yaml
      // builtins) — heuristic is a FALLBACK only.
      if (estimates[slug] === undefined) estimates[slug] = score;
    }
  }
  return estimates;
}