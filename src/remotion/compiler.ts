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

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

type BabelNodeLike = Record<string, unknown> & {
  type?: string;
  start?: number;
  end?: number;
};

function parseGeneratedCode(code: string): unknown {
  try {
    return Babel.packages.parser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return undefined;
  }
}

function getMissingRemotionHookBindings(code: string): string[] {
  const ast = parseGeneratedCode(
    `const DynamicAnimation = () => {\n${code}\n};`,
  ) as BabelNodeLike | undefined;
  if (!ast) return [];

  const bindings = new Set<string>();
  const references = new Set<string>();
  const bindingNodes = new WeakSet<object>();

  const markBindingPattern = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(markBindingPattern);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as BabelNodeLike;
    if (node.type === "Identifier") {
      bindingNodes.add(node);
      if (typeof node.name === "string") bindings.add(node.name);
      return;
    }
    if (node.type === "ObjectPattern") {
      const properties = node.properties;
      if (Array.isArray(properties)) {
        for (const property of properties) {
          const propertyNode = property as BabelNodeLike;
          markBindingPattern(
            propertyNode.type === "RestElement"
              ? propertyNode.argument
              : propertyNode.value,
          );
        }
      }
    } else if (node.type === "ArrayPattern") {
      if (Array.isArray(node.elements)) {
        node.elements.forEach(markBindingPattern);
      }
    } else if (node.type === "RestElement") {
      markBindingPattern(node.argument);
    } else if (node.type === "AssignmentPattern") {
      markBindingPattern(node.left);
    } else if (node.type === "TSParameterProperty") {
      markBindingPattern(node.parameter);
    }
  };

  const visit = (
    value: unknown,
    parent?: BabelNodeLike,
    parentKey?: string,
  ): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, parent, parentKey));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as BabelNodeLike;

    if (node.type === "VariableDeclarator") {
      markBindingPattern(node.id);
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ObjectMethod" ||
      node.type === "ClassMethod" ||
      node.type === "ClassPrivateMethod" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      if (node.id) markBindingPattern(node.id);
      markBindingPattern(node.params);
    } else if (node.type === "CatchClause") {
      markBindingPattern(node.param);
    } else if (
      node.type === "ImportSpecifier" ||
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier"
    ) {
      markBindingPattern(node.local);
    }

    if (node.type === "Identifier" && !bindingNodes.has(node)) {
      const isNonComputedProperty =
        ((parent?.type === "MemberExpression" ||
          parent?.type === "OptionalMemberExpression") &&
          parentKey === "property" &&
          parent.computed !== true) ||
        ((parent?.type === "ObjectProperty" ||
          parent?.type === "ObjectMethod") &&
          parentKey === "key" &&
          parent.computed !== true &&
          parent.shorthand !== true) ||
        (parent?.type === "LabeledStatement" && parentKey === "label") ||
        ((parent?.type === "BreakStatement" ||
          parent?.type === "ContinueStatement") &&
          parentKey === "label");
      if (!isNonComputedProperty && typeof node.name === "string") {
        references.add(node.name);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      visit(child, node, key);
    }
  };

  visit(ast);
  return ["frame", "fps", "durationInFrames"].filter(
    (name) => references.has(name) && !bindings.has(name),
  );
}

function addMissingRemotionHookBindings(code: string): string {
  const missingBindings = getMissingRemotionHookBindings(code);
  if (missingBindings.length === 0) return code;

  const hookDeclarations: string[] = [];
  if (missingBindings.includes("frame")) {
    hookDeclarations.push("const frame = useCurrentFrame();");
  }
  const videoConfigBindings = missingBindings.filter(
    (name) => name === "fps" || name === "durationInFrames",
  );
  if (videoConfigBindings.length > 0) {
    hookDeclarations.push(
      `const { ${videoConfigBindings.join(", ")} } = useVideoConfig();`,
    );
  }
  return `${hookDeclarations.join("\n")}\n${code}`;
}

function skipQuotedText(code: string, start: number): number {
  const quote = code[start];
  for (let index = start + 1; index < code.length; index++) {
    if (code[index] === "\\") {
      index++;
    } else if (code[index] === quote) {
      return index + 1;
    }
  }
  return code.length;
}

function skipTrivia(code: string, start: number): number {
  let index = start;
  while (index < code.length) {
    if (/\s/.test(code[index])) {
      index++;
    } else if (code.startsWith("//", index)) {
      const lineEnd = code.indexOf("\n", index + 2);
      index = lineEnd === -1 ? code.length : lineEnd + 1;
    } else if (code.startsWith("/*", index)) {
      const commentEnd = code.indexOf("*/", index + 2);
      index = commentEnd === -1 ? code.length : commentEnd + 2;
    } else {
      break;
    }
  }
  return index;
}

function findClosingDelimiter(
  code: string,
  start: number,
  opening: string,
  closing: string,
): number | undefined {
  let depth = 0;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuotedText(code, index) - 1;
      continue;
    }
    if (code.startsWith("//", index)) {
      const lineEnd = code.indexOf("\n", index + 2);
      index = lineEnd === -1 ? code.length : lineEnd;
      continue;
    }
    if (code.startsWith("/*", index)) {
      const commentEnd = code.indexOf("*/", index + 2);
      index = commentEnd === -1 ? code.length : commentEnd + 1;
      continue;
    }
    if (char === opening) {
      depth++;
    } else if (char === closing) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function isClampOptionsObject(source: string): boolean {
  try {
    const ast = parseGeneratedCode(`const options = (${source});`) as
      | BabelNodeLike
      | undefined;
    if (!ast) return false;
    const program = ast.program as BabelNodeLike | undefined;
    const statement = (program?.body as BabelNodeLike[] | undefined)?.[0];
    const declaration = (
      statement?.declarations as BabelNodeLike[] | undefined
    )?.[0];
    const object = declaration?.init as BabelNodeLike | undefined;
    if (object?.type !== "ObjectExpression") return false;

    const properties = object.properties as BabelNodeLike[] | undefined;
    const clampProperties = new Set<string>();
    for (const property of properties ?? []) {
      if (property.type !== "ObjectProperty") continue;
      const key = property.key as BabelNodeLike | undefined;
      const value = property.value as BabelNodeLike | undefined;
      if (
        (key?.name === "extrapolateLeft" ||
          key?.name === "extrapolateRight") &&
        value?.type === "StringLiteral" &&
        value.value === "clamp"
      ) {
        clampProperties.add(key.name);
      }
    }
    return (
      clampProperties.has("extrapolateLeft") &&
      clampProperties.has("extrapolateRight")
    );
  } catch {
    return false;
  }
}

function applySourceEdits(code: string, edits: SourceEdit[]): string {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (updated, edit) =>
        updated.slice(0, edit.start) + edit.text + updated.slice(edit.end),
      code,
    );
}

function maskNonCodeText(code: string): string {
    const chars = code.split("");
    for (let index = 0; index < code.length; index++) {
      const char = code[index];
      if (char === "'" || char === '"' || char === "`") {
        const end = skipQuotedText(code, index);
        for (let masked = index; masked < end; masked++) {
          if (chars[masked] !== "\n" && chars[masked] !== "\r") chars[masked] = " ";
        }
        index = end - 1;
      } else if (code.startsWith("//", index)) {
        const lineEnd = code.indexOf("\n", index + 2);
        const end = lineEnd === -1 ? code.length : lineEnd;
        for (let masked = index; masked < end; masked++) chars[masked] = " ";
        index = end - 1;
      } else if (code.startsWith("/*", index)) {
        const commentEnd = code.indexOf("*/", index + 2);
        const end = commentEnd === -1 ? code.length : commentEnd + 2;
        for (let masked = index; masked < end; masked++) {
          if (chars[masked] !== "\n" && chars[masked] !== "\r") chars[masked] = " ";
        }
        index = end - 1;
      }
    }
    return chars.join("");
}

function repairSplitCamelCaseIdentifiers(code: string): string {
    const maskedCode = maskNonCodeText(code);
    const declarationPattern =
      /\b(?:const|let|var)\s+([a-z_$][\w$]*(?:\s+[A-Z][\w$]*)+)\s*=/g;
    const candidates = new Set<string>();

    for (const match of maskedCode.matchAll(declarationPattern)) {
      candidates.add((match[1] ?? "").trim().split(/\s+/).join(" "));
    }

    const edits: SourceEdit[] = [];
    for (const candidate of [...candidates].sort(
      (left, right) => right.length - left.length,
    )) {
      const words = candidate.split(" ");
      const splitIdentifierPattern = words
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");
      const occurrencePattern = new RegExp(
        `(^|[^\\w$])(${splitIdentifierPattern})(?=$|[^\\w$])`,
        "g",
      );

      for (const match of maskedCode.matchAll(occurrencePattern)) {
        const prefixLength = match[1]?.length ?? 0;
        const start = (match.index ?? 0) + prefixLength;
        const end = start + (match[2]?.length ?? 0);
        if (!edits.some((edit) => start < edit.end && end > edit.start)) {
          edits.push({ start, end, text: words.join("") });
        }
      }
    }

    return applySourceEdits(code, edits);
}

function repairMisplacedClampOptions(code: string): string {
  const edits: SourceEdit[] = [];
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (char === "'" || char === '"' || char === "`") {
      index = skipQuotedText(code, index) - 1;
      continue;
    }
    if (code.startsWith("//", index)) {
      const lineEnd = code.indexOf("\n", index + 2);
      index = lineEnd === -1 ? code.length : lineEnd;
      continue;
    }
    if (code.startsWith("/*", index)) {
      const commentEnd = code.indexOf("*/", index + 2);
      index = commentEnd === -1 ? code.length : commentEnd + 1;
      continue;
    }
    if (
      code.slice(index, index + "interpolate".length) !== "interpolate" ||
      /[\w$]/.test(code[index - 1] ?? "")
    ) {
      continue;
    }

    const afterName = index + "interpolate".length;
    if (/[\w$]/.test(code[afterName] ?? "")) continue;
    const openParen = skipTrivia(code, afterName);
    if (code[openParen] !== "(") continue;
    const closeParen = findClosingDelimiter(code, openParen, "(", ")");
    if (closeParen === undefined) continue;

    const comma = skipTrivia(code, closeParen + 1);
    if (code[comma] !== ",") continue;
    const optionsStart = skipTrivia(code, comma + 1);
    if (code[optionsStart] !== "{") continue;
    const optionsEnd = findClosingDelimiter(code, optionsStart, "{", "}");
    if (optionsEnd === undefined) continue;
    const options = code.slice(optionsStart, optionsEnd + 1);
    if (!isClampOptionsObject(options)) continue;

    const callPrefix = "const __interpolateCall = ";
    const callAst = parseGeneratedCode(
      `${callPrefix}${code.slice(index, closeParen + 1)};`,
    ) as BabelNodeLike | undefined;
    const callProgram = callAst?.program as BabelNodeLike | undefined;
    const callStatement = (callProgram?.body as BabelNodeLike[] | undefined)?.[0];
    const callDeclaration = (
      callStatement?.declarations as BabelNodeLike[] | undefined
    )?.[0];
    const call = callDeclaration?.init as BabelNodeLike | undefined;
    const args = call?.arguments as BabelNodeLike[] | undefined;
    const lastArgument = args?.[2];
    if (
      call?.type !== "CallExpression" ||
      args?.length !== 3 ||
      typeof lastArgument?.end !== "number"
    ) {
      continue;
    }

    edits.push({
      start: index + lastArgument.end - callPrefix.length,
      end: index + lastArgument.end - callPrefix.length,
      text: `,${code.slice(comma + 1, optionsStart)}${options}`,
    });
    edits.push({
      start: comma,
      end: optionsEnd + 1,
      text: "",
    });
    index = optionsEnd;
  }
  return applySourceEdits(code, edits);
}

function fixInterpolateCalls(code: string): string {
  let ast = parseGeneratedCode(code) as BabelNodeLike | undefined;
  if (!ast) {
    code = repairMisplacedClampOptions(code);
    ast = parseGeneratedCode(code) as BabelNodeLike | undefined;
  }
  if (!ast) return code;

  let hasSceneDuration = false;
  const nodes: BabelNodeLike[] = [];
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object" || visited.has(value)) {
      return;
    }
    visited.add(value);
    const node = value as BabelNodeLike;
    if (typeof node.type !== "string") return;
    nodes.push(node);
    if (node.type === "VariableDeclarator") {
      const identifier = node.id as BabelNodeLike | undefined;
      if (
        identifier?.type === "Identifier" &&
        identifier.name === "SCENE_DURATION"
      ) {
        hasSceneDuration = true;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);

  const edits: SourceEdit[] = [];
  for (const node of nodes) {
    if (node.type !== "CallExpression") continue;
    const callee = node.callee as BabelNodeLike | undefined;
    const member =
      callee?.type === "MemberExpression"
        ? (callee.property as BabelNodeLike | undefined)
        : undefined;
    if (
      callee?.name !== "interpolate" &&
      !(member?.type === "Identifier" && member.name === "interpolate")
    ) {
      continue;
    }
    const args = node.arguments as BabelNodeLike[] | undefined;
    if (args?.length !== 3) continue;

    const inputRange = args[1];
    if (
      hasSceneDuration &&
      inputRange?.type === "ArrayExpression" &&
      Array.isArray(inputRange.elements) &&
      inputRange.elements.length === 2
    ) {
      const elements = inputRange.elements as BabelNodeLike[];
      const rangeText =
        typeof inputRange.start === "number" &&
        typeof inputRange.end === "number"
          ? code.slice(inputRange.start, inputRange.end)
          : "";
      if (
        elements[0]?.type === "NumericLiteral" &&
        elements[0].value === 0 &&
        elements[1]?.type === "NumericLiteral" &&
        elements[1].value === 60 &&
        /^\[\s*0\s*,\s*60\s*\]$/.test(rangeText) &&
        typeof inputRange.start === "number" &&
        typeof inputRange.end === "number"
      ) {
        edits.push({
          start: inputRange.start,
          end: inputRange.end,
          text: "[0, SCENE_DURATION]",
        });
      }
    }

    const lastArgument = args[2];
    if (typeof lastArgument?.end === "number") {
      edits.push({
        start: lastArgument.end,
        end: lastArgument.end,
        text: ', { extrapolateLeft: "clamp", extrapolateRight: "clamp" }',
      });
    }
  }

  return applySourceEdits(code, edits);
}

// Strip imports and extract component body from LLM-generated code
// Safety layer in case LLM includes full ES6 syntax despite instructions
// ─── Fix common AI syntax errors ───
export function fixCommonSyntaxErrors(code: string): string {
  code = repairSplitCamelCaseIdentifiers(code);

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

  return fixInterpolateCalls(code);
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
    return addMissingRemotionHookBindings(cleanedHelpers
      ? `${cleanedHelpers}\n\n${cleanedBody}`
      : cleanedBody);
  }

  // Step 4: Fallback - const X = () => {...}
  const fallbackMatch = cleaned.match(/^([\s\S]*?)const\s+\w+\s*=\s*\(\s*\)\s*=>\s*\{([\s\S]*)\};?\s*$/);
  if (fallbackMatch) {
    const helpers = fallbackMatch[1].trim();
    const body = fallbackMatch[2].trim();
    return addMissingRemotionHookBindings(helpers ? `${helpers}\n\n${body}` : body);
  }

  // Step 5: Last resort
  return addMissingRemotionHookBindings(
    cleaned.replace(/^\s*export\s+/gm, ""),
  );
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
