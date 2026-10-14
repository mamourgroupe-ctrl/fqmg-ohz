import * as Babel from "@babel/standalone";
import { Lottie } from "@remotion/lottie";
import * as RemotionShapes from "@remotion/shapes";
import { ThreeCanvas } from "@remotion/three";
import {
  TransitionSeries,
  linearTiming,
  springTiming,
} from "@remotion/transitions";
import { clockWipe } from "@remotion/transitions/clock-wipe";
import { fade } from "@remotion/transitions/fade";
import { flip } from "@remotion/transitions/flip";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";
import * as THREE from "three";
import { loadFont as loadCairo } from "@remotion/google-fonts/Cairo";
import { loadFont as loadTajawal } from "@remotion/google-fonts/Tajawal";

// ─── Preload Arabic Fonts (available at render time) ───
loadCairo(); // preload Cairo
loadTajawal(); // preload Tajawal
export interface CompilationResult {
  Component: React.ComponentType | null;
  error: string | null;
}

// Strip imports and extract component body from LLM-generated code
// Safety layer in case LLM includes full ES6 syntax despite instructions
// ─── Fix common AI syntax errors ───
export function fixCommonSyntaxErrors(code: string): string {
  // Close destructured callback parameters when generated arrow functions omit `)`.
  code = code.replace(/\(\s*\{\s*transition\s*\}\s*=>/g, "({ transition }) =>");
  code = code.replace(/\bdurationIn\s+Frames\b/g, "durationInFrames");

  // Fix `const NAME NAME NAME = ...` → `const NAME_NAME_NAME = ...`
  // Handles any number of uppercase words: COLOR UNDERLINE, LOGO ENTER DURATION, etc.
  code = code.replace(
    /const\s+([A-Z][A-Z0-9]*(?:\s+[A-Z][A-Z0-9]*)+)\s*=/g,
    (match, names) => `const ${names.replace(/\s+/g, "_")} =`,
  );

  // Fix `const name name = ...` (lowercase)
  code = code.replace(
    /const\s+([a-z][a-zA-Z0-9]*)\s+([a-z][a-zA-Z0-9]*)\s*=/g,
    (match, a, b) => {
      if (a === b) return match; // ignore "const x x ="
      return `const ${a}${b.charAt(0).toUpperCase() + b.slice(1)} =`;
    },
  );

  // Move misplaced interpolate options back inside the call.
  code = code.replace(
    /(interpolate\s*\(\s*([^,]+)\s*,\s*(\[[^\]]+\])\s*,\s*(\[[^\]]+\])\s*\))\s*,\s*(\{\s*extrapolateLeft\s*:\s*["']clamp["']\s*,\s*extrapolateRight\s*:\s*["']clamp["']\s*\})/g,
    (match, call) => {
      const options = match.slice(call.length).replace(/^\s*,\s*/, "");
      return `${call.slice(0, -1)}, ${options})`;
    },
  );

  // Fix interpolate calls missing clamp options
  // interpolate(frame, [0, 60], [0, 1]) → interpolate(frame, [0, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  code = code.replace(
    /interpolate\s*\(\s*([^,]+)\s*,\s*(\[[^\]]+\])\s*,\s*(\[[^\]]+\])\s*\)/g,
    (match) => {
      const callWithoutClosingParen = match.replace(/\s*\)$/, "");
      return `${callWithoutClosingParen}, { extrapolateLeft: "clamp", extrapolateRight: "clamp" })`;
    },
  );

  // Replace hardcoded [0, 60] with [0, SCENE_DURATION] when SCENE_DURATION is defined
  // Check if SCENE_DURATION constant exists in the code
  const hasSceneDuration = /const\s+SCENE_DURATION\s*=/.test(code);
  if (hasSceneDuration) {
    code = code.replace(
      /interpolate\s*\(\s*([^,]+)\s*,\s*\[\s*0\s*,\s*60\s*\]/g,
      "interpolate($1, [0, SCENE_DURATION]",
    );
  }

  // Convert <img src="..."> to <Img src={staticFile("...")} />
  // Handle both double and single quotes, and assets/ paths
  // Also handle additional attributes like alt, className, etc.
  code = code.replace(
    /<img\s+src=(["'])\/?(assets\/[^"']+)\1[^>]*>/g,
    '<Img src={staticFile("/$2")} />',
  );
  code = code.replace(
    /<img\s+src=(["'])\/?([^"']+\.(?:jpeg|jpg|png|gif|webp|svg))\1[^>]*>/gi,
    '<Img src={staticFile("/$2")} />',
  );

  return code;
}

// ─── Ensure required Remotion imports are present ───
const REMOTION_IMPORTS = [
  "staticFile",
  "Img",
  "AbsoluteFill",
  "Sequence",
  "interpolate",
  "useCurrentFrame",
  "useVideoConfig",
  "spring",
] as const;

type RemotionImport = (typeof REMOTION_IMPORTS)[number];

export function ensureRequiredImports(code: string): string {
  // Detect which Remotion imports are used in the code
  const usedImports = new Set<RemotionImport>();

  for (const imp of REMOTION_IMPORTS) {
    // Check for usage patterns: staticFile(, <Img, AbsoluteFill, Sequence, interpolate(, useCurrentFrame(, useVideoConfig(, spring(
    const patterns: RegExp[] = [
      new RegExp(`\\b${imp}\\s*\\(`), // function call: staticFile(
      new RegExp(`<${imp}\\b`), // JSX element: <Img
      new RegExp(`\\b${imp}\\b`), // general identifier usage
    ];

    for (const pattern of patterns) {
      if (pattern.test(code)) {
        usedImports.add(imp);
        break;
      }
    }
  }

  if (usedImports.size === 0) {
    return code; // No Remotion imports needed
  }

  // Find existing import from "remotion"
  const importRegex = /^import\s*\{([^}]+)\}\s*from\s*["']remotion["'];?/m;
  const match = code.match(importRegex);

  if (match) {
    // Existing import found - merge missing imports
    const existingImports = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const existingSet = new Set(existingImports);

    const missingImports = Array.from(usedImports).filter((imp) => !existingSet.has(imp));

    if (missingImports.length === 0) {
      return code; // All needed imports already present
    }

    // Merge and rebuild import statement
    const allImports = [...Array.from(existingImports), ...missingImports].sort();
    const newImport = `import { ${allImports.join(", ")} } from "remotion";`;
    return code.replace(importRegex, newImport);
  }

  // Check for default import: import something from "remotion"
  const defaultImportRegex = /^import\s+(\w+)\s+from\s*["']remotion["'];?/m;
  const defaultMatch = code.match(defaultImportRegex);

  if (defaultMatch) {
    // Convert default import to named import with all needed
    const allImports = Array.from(usedImports).sort();
    const newImport = `import { ${allImports.join(", ")} } from "remotion";`;
    return code.replace(defaultImportRegex, newImport);
  }

  // Check for namespace import: import * as X from "remotion"
  const namespaceImportRegex = /^import\s*\*\s+as\s+\w+\s+from\s*["']remotion["'];?/m;
  const namespaceMatch = code.match(namespaceImportRegex);

  if (namespaceMatch) {
    // Add named import alongside namespace import
    const allImports = Array.from(usedImports).sort();
    const newImport = `import { ${allImports.join(", ")} } from "remotion";`;
    return code.replace(namespaceImportRegex, `${namespaceMatch[0]}\n${newImport}`);
  }

  // No existing remotion import - add new one at the top
  const allImports = Array.from(usedImports).sort();
  const newImport = `import { ${allImports.join(", ")} } from "remotion";\n`;
  return newImport + code;
}

// ─── Remove unused Remotion imports ───
export function removeUnusedImports(code: string): string {
  // Find the remotion import statement - handle all forms including combined
  // Combined: import Default, { named1, named2 } from "remotion"
  const combinedImportRegex = /^import\s+(\w+)\s*,\s*\{([^}]*)\}\s*from\s*["']remotion["'];?/m;
  const namedImportRegex = /^import\s*\{([^}]*)\}\s*from\s*["']remotion["'];?/m;
  const defaultImportRegex = /^import\s+(\w+)\s+from\s*["']remotion["'];?/m;
  const namespaceImportRegex = /^import\s*\*\s+as\s+(\w+)\s+from\s*["']remotion["'];?/m;

  const combinedMatch = code.match(combinedImportRegex);
  const namedMatch = code.match(namedImportRegex);
  const defaultMatch = code.match(defaultImportRegex);
  const namespaceMatch = code.match(namespaceImportRegex);

  // If no remotion import found, return as-is
  if (!combinedMatch && !namedMatch && !defaultMatch && !namespaceMatch) {
    return code;
  }

  // Find the position of the import statement to only check code AFTER it
  let importEndPos = 0;
  const importLine = combinedMatch?.[0] || namedMatch?.[0] || defaultMatch?.[0] || namespaceMatch?.[0];
  if (importLine) {
    importEndPos = code.indexOf(importLine) + importLine.length;
  }

  const codeAfterImport = code.slice(importEndPos);

  // Tokenize codeAfterImport to find identifiers, skipping strings, comments, and JSX attributes
  const usedIdentifiers = new Set<string>();
  let i = 0;
  while (i < codeAfterImport.length) {
    const ch = codeAfterImport[i];

    // Skip single-line comments
    if (ch === "/" && codeAfterImport[i + 1] === "/") {
      i += 2;
      while (i < codeAfterImport.length && codeAfterImport[i] !== "\n") i++;
      continue;
    }

    // Skip multi-line comments
    if (ch === "/" && codeAfterImport[i + 1] === "*") {
      i += 2;
      while (i < codeAfterImport.length - 1 && !(codeAfterImport[i] === "*" && codeAfterImport[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }

    // Skip string literals (single, double, template)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < codeAfterImport.length) {
        if (codeAfterImport[i] === "\\" && i + 1 < codeAfterImport.length) {
          i += 2; // escaped char
        } else if (codeAfterImport[i] === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Skip JSX attributes (identifier followed by = or {)
    // e.g., <div Img="..." /> or <div Img={...} />
    const jsxAttrMatch = codeAfterImport.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*[={]/);
    if (jsxAttrMatch) {
      i += jsxAttrMatch[0].length - 1; // -1 to leave the = or { for next iteration
      continue;
    }

    // Match identifiers (including JSX tags like <Img)
    const identMatch = codeAfterImport.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (identMatch) {
      usedIdentifiers.add(identMatch[0]);
      i += identMatch[0].length;
      continue;
    }

    i++;
  }

  // Process based on import type found
  if (combinedMatch) {
    // Combined import: import Default, { named1, named2 } from "remotion"
    const defaultName = combinedMatch[1];
    const namedNames = combinedMatch[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const usedNamed = namedNames.filter((name) => usedIdentifiers.has(name));
    const defaultUsed = usedIdentifiers.has(defaultName);

    if (usedNamed.length === 0 && !defaultUsed) {
      // Nothing used - remove entire import
      return code.replace(combinedImportRegex, "").trimStart();
    }

    if (usedNamed.length === 0 && defaultUsed) {
      // Only default used - keep only default
      const newImport = `import ${defaultName} from "remotion";`;
      return code.replace(combinedImportRegex, newImport);
    }

    if (usedNamed.length > 0 && !defaultUsed) {
      // Only named used - convert to named-only import
      const newImport = `import { ${usedNamed.join(", ")} } from "remotion";`;
      return code.replace(combinedImportRegex, newImport);
    }

    // Both used
    const newImport = `import ${defaultName}, { ${usedNamed.join(", ")} } from "remotion";`;
    return code.replace(combinedImportRegex, newImport);
  }

  if (namedMatch) {
    // Named import: import { a, b } from "remotion"
    const importedNames = namedMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const usedNames = importedNames.filter((name) => usedIdentifiers.has(name));

    if (usedNames.length === 0) {
      // Remove entire import statement
      return code.replace(namedImportRegex, "").trimStart();
    }

    // Rebuild with only used names
    const newImport = `import { ${usedNames.join(", ")} } from "remotion";`;
    return code.replace(namedImportRegex, newImport);
  }

  if (defaultMatch) {
    // Default import: import X from "remotion"
    const defaultName = defaultMatch[1];
    if (!usedIdentifiers.has(defaultName)) {
      // Default not used - remove the import
      return code.replace(defaultImportRegex, "").trimStart();
    }
    return code; // Default is used, keep as-is
  }

  if (namespaceMatch) {
    // Namespace import: import * as X from "remotion"
    const namespaceName = namespaceMatch[1];
    // Check if namespace is used (e.g., X.Img, X.staticFile)
    const namespaceUsed = usedIdentifiers.has(namespaceName);
    if (!namespaceUsed) {
      return code.replace(namespaceImportRegex, "").trimStart();
    }
    return code; // Namespace is used, keep as-is
  }

  return code;
}

export function extractComponentBody(code: string): string {
  // Step 0: Ensure required Remotion imports are present
  let cleaned = ensureRequiredImports(code);
  // Step 0.5: Remove unused Remotion imports (add-first, then prune)
  cleaned = removeUnusedImports(cleaned);

  // Step 1: Strip ALL import statements
  cleaned = cleaned.replace(/import\s+type\s*\{[\s\S]*?\}\s*from\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.replace(/import\s+\w+\s*,\s*\{[\s\S]*?\}\s*from\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.replace(/import\s+\*\s+as\s+\w+\s+from\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.replace(/import\s+\w+\s+from\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.replace(/import\s*["'`][^"'`]+["'`];?/g, "");
  cleaned = cleaned.trim();

  // Step 2: Fix common syntax errors
  cleaned = fixCommonSyntaxErrors(cleaned);

  // Step 3: Extract helpers + body from `export const X = () => {...}`
  const match = cleaned.match(/^([\s\S]*?)export\s+const\s+\w+\s*=\s*\(\s*\)\s*=>\s*\{([\s\S]*)\};?\s*$/);
  if (match) {
    const helpers = match[1].trim();
    const body = match[2].trim();
    // Clean any remaining export keywords
    const cleanedHelpers = helpers.replace(/^\s*export\s+/gm, "");
    const cleanedBody = body.replace(/^\s*export\s+/gm, "");
    return cleanedHelpers
      ? `${cleanedHelpers}\n\n${cleanedBody}`
      : cleanedBody;
  }

  // Step 4: Fallback - const X = () => {...}
  const fallbackMatch = cleaned.match(/^([\s\S]*?)const\s+\w+\s*=\s*\(\s*\)\s*=>\s*\{([\s\S]*)\};?\s*$/);
  if (fallbackMatch) {
    const helpers = fallbackMatch[1].trim();
    const body = fallbackMatch[2].trim();
    return helpers ? `${helpers}\n\n${body}` : body;
  }

  // Step 5: Last resort
  return cleaned.replace(/^\s*export\s+/gm, "");
}

// Standalone compile function for use outside React components
export function compileCode(code: string): CompilationResult {
  if (!code?.trim()) {
    return { Component: null, error: "No code provided" };
  }

  try {
    const componentBody = extractComponentBody(code);
    const wrappedSource = `const DynamicAnimation = () => {\n${componentBody}\n};`;

    const transpiled = Babel.transform(wrappedSource, {
      presets: ["react", "typescript"],
      filename: "dynamic-animation.tsx",
    });

    if (!transpiled.code) {
      return { Component: null, error: "Transpilation failed" };
    }

    const Remotion = {
      AbsoluteFill,
      interpolate,
      useCurrentFrame,
      useVideoConfig,
      spring,
      Sequence,
      Img,
      staticFile,
    };

    const wrappedCode = `${transpiled.code}\nreturn DynamicAnimation;`;

    const createComponent = new Function(
      "React",
      "Remotion",
      "RemotionShapes",
      "Lottie",
      "ThreeCanvas",
      "THREE",
      "AbsoluteFill",
      "interpolate",
      "useCurrentFrame",
      "useVideoConfig",
      "spring",
      "Sequence",
      "Img",
      "staticFile",
      "useState",
      "useEffect",
      "useMemo",
      "useRef",
      "Rect",
      "Circle",
      "Triangle",
      "Star",
      "Polygon",
      "Ellipse",
      "Heart",
      "Pie",
      "makeRect",
      "makeCircle",
      "makeTriangle",
      "makeStar",
      "makePolygon",
      "makeEllipse",
      "makeHeart",
      "makePie",
      // Transitions
      "TransitionSeries",
      "linearTiming",
      "springTiming",
      "fade",
      "slide",
      "wipe",
      "flip",
      "clockWipe",
      wrappedCode,
    );

    const Component = createComponent(
      React,
      Remotion,
      RemotionShapes,
      Lottie,
      ThreeCanvas,
      THREE,
      AbsoluteFill,
      interpolate,
      useCurrentFrame,
      useVideoConfig,
      spring,
      Sequence,
      Img,
      staticFile,
      useState,
      useEffect,
      useMemo,
      useRef,
      RemotionShapes.Rect,
      RemotionShapes.Circle,
      RemotionShapes.Triangle,
      RemotionShapes.Star,
      RemotionShapes.Polygon,
      RemotionShapes.Ellipse,
      RemotionShapes.Heart,
      RemotionShapes.Pie,
      RemotionShapes.makeRect,
      RemotionShapes.makeCircle,
      RemotionShapes.makeTriangle,
      RemotionShapes.makeStar,
      RemotionShapes.makePolygon,
      RemotionShapes.makeEllipse,
      RemotionShapes.makeHeart,
      RemotionShapes.makePie,
      // Transitions
      TransitionSeries,
      linearTiming,
      springTiming,
      fade,
      slide,
      wipe,
      flip,
      clockWipe,
    );

    if (typeof Component !== "function") {
      return {
        Component: null,
        error: "Code must be a function that returns a React component",
      };
    }

    return { Component, error: null };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown compilation error";
    return { Component: null, error: errorMessage };
  }
}
