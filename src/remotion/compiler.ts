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
function fixCommonSyntaxErrors(code: string): string {
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

function ensureRequiredImports(code: string): string {
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

function extractComponentBody(code: string): string {
  // Step 0: Ensure required Remotion imports are present
  let cleaned = ensureRequiredImports(code);

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
