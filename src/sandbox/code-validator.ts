import * as Babel from "@babel/standalone";

/**
 * Phase 4 — static security gate for LLM-generated Remotion code.
 *
 * Generated code used to be evaluated with `new Function` directly in the main
 * page context (docs/current-architecture.md flags this as the main isolation
 * hazard). This validator is the first, context-independent layer: it parses
 * the extracted component body and enforces a FAIL-CLOSED identifier
 * whitelist — every referenced global must be explicitly allowed, every
 * member/property escape hatch is rejected, dynamic `import()`, import/export
 * statements and `with` are rejected outright.
 *
 * It never executes the code and violations carry only names/kinds — never raw
 * source — so they are safe to echo back to clients and logs.
 */

export type CodeViolationKind =
  | "parse"
  | "global"
  | "assignment"
  | "member"
  | "computed-access"
  | "dynamic-import"
  | "import"
  | "with-statement";

export interface CodeViolation {
  kind: CodeViolationKind;
  name: string;
}

export interface CodeValidationResult {
  ok: boolean;
  violations: CodeViolation[];
}

/** React/Remotion injections (mirrors the compiler's `new Function` params). */
const REMOTION_INJECTIONS = [
  "React",
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
  "TransitionSeries",
  "linearTiming",
  "springTiming",
  "fade",
  "slide",
  "wipe",
  "flip",
  "clockWipe",
] as const;

/** Deterministic JavaScript builtins a generated component may legitimately use. */
const SAFE_BUILTINS = [
  "Math",
  "JSON",
  "Date",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Symbol",
  "BigInt",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "RegExp",
  "isFinite",
  "isNaN",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "structuredClone",
  "undefined",
  "NaN",
  "Infinity",
  "console",
] as const;

/** TypeScript utility types usable in annotations inside generated code. */
const SAFE_TS_TYPES = [
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "Awaited",
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
] as const;

/**
 * The whitelist is exported so tests can prove it never contains escape
 * hatches (eval, Function, document, fetch, ...).
 */
export const SANDBOX_ALLOWED_GLOBALS: ReadonlySet<string> = new Set([
  ...REMOTION_INJECTIONS,
  ...SAFE_BUILTINS,
  ...SAFE_TS_TYPES,
]);

/** Member names that enable realm/reference escapes and are never needed. */
const FORBIDDEN_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "caller",
  "callee",
  "arguments",
  "importScripts",
]);

const IMPORT_STATEMENT_PATTERNS = [
  /^\s*import\s+type\s*\{/m,
  /^\s*import\s*["']/m,
  /^\s*import\s*\*/m,
  /^\s*import\s*\{/m,
  /^\s*import\s+\w+\s*,/m,
  /^\s*import\s+\w+\s+from/m,
];

const WITH_STATEMENT_PATTERN = /(^|[^.\w])with\s*\(/m;

type BabelNodeLike = Record<string, unknown> & {
  type?: string;
  start?: number;
  end?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects DECLARED NAMES in the wrapped function body (one flat scope).
 * Name-based resolution is sound here: a malicious body can shadow any name
 * with its own local, but shadowing is self-contained — reaching a REAL
 * escape-hatch global always requires an unbound reference, which is exactly
 * what gets flagged.
 */
function collectDeclaredNames(root: BabelNodeLike, declared: Set<string>): void {
  const markPattern = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(markPattern);
      return;
    }
    if (!isRecord(value)) return;
    const node = value as BabelNodeLike;
    if (node.type === "Identifier") {
      if (typeof node.name === "string") declared.add(node.name);
      return;
    }
    if (node.type === "ObjectPattern") {
      for (const property of node.properties as unknown[]) {
        if (isRecord(property)) {
          markPattern(property.type === "RestElement" ? property.argument : (property.value ?? property.key));
        }
      }
      return;
    }
    if (node.type === "ArrayPattern") {
      for (const element of node.elements as unknown[]) markPattern(element);
      return;
    }
    if (node.type === "AssignmentPattern") {
      markPattern(node.left);
      return;
    }
    if (node.type === "RestElement") {
      markPattern(node.argument);
      return;
    }
    if (node.type === "TSParameterProperty") {
      markPattern(node.parameter);
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    const node = value as BabelNodeLike;

    if (node.type === "VariableDeclarator") {
      markPattern(node.id);
    } else if (
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration"
    ) {
      if (isRecord(node.id) && typeof (node.id as { name?: unknown }).name === "string") {
        declared.add((node.id as { name: string }).name);
      }
    } else if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassExpression" ||
      node.type === "ClassMethod" ||
      node.type === "ObjectMethod"
    ) {
      const params = (node.params ?? []) as unknown[];
      params.forEach(markPattern);
    } else if (node.type === "CatchClause") {
      markPattern(node.param);
    } else if (
      node.type === "TSTypeAliasDeclaration" ||
      node.type === "TSInterfaceDeclaration" ||
      node.type === "TSEnumDeclaration"
    ) {
      if (isRecord(node.id) && typeof (node.id as { name?: unknown }).name === "string") {
        declared.add((node.id as { name: string }).name);
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(child);
    }
  };
  visit(root);
}

export function validateGeneratedCode(body: string): CodeValidationResult {
  const violations: CodeViolation[] = [];
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) {
    return { ok: false, violations: [{ kind: "parse", name: "empty" }] };
  }

  // Statements that cannot appear inside the wrapped function body are caught
  // textually first (a module-level `import` makes the wrapped parse fail).
  if (IMPORT_STATEMENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    violations.push({ kind: "import", name: "import" });
  }
  if (WITH_STATEMENT_PATTERN.test(trimmed)) {
    violations.push({ kind: "with-statement", name: "with" });
  }

  let ast: BabelNodeLike;
  try {
    ast = Babel.packages.parser.parse(
      `const DynamicAnimation = () => {\n${trimmed}\n};`,
      { sourceType: "module", plugins: ["jsx", "typescript"] },
    ) as unknown as BabelNodeLike;
  } catch {
    if (violations.length > 0) {
      return { ok: false, violations };
    }
    return { ok: false, violations: [{ kind: "parse", name: "unparseable" }] };
  }

  const declared = new Set<string>();
  collectDeclaredNames(ast, declared);

  const isAllowedGlobal = (name: string): boolean => SANDBOX_ALLOWED_GLOBALS.has(name);

  const visit = (value: unknown, parent?: BabelNodeLike, parentKey?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, parent, parentKey));
      return;
    }
    if (!isRecord(value)) return;
    const node = value as BabelNodeLike;

    if (node.type === "Identifier") {
      const name = typeof node.name === "string" ? node.name : "";
      if (!name || declared.has(name)) return;

      const isMemberProperty =
        parent?.type === "MemberExpression" && parentKey === "property" && !parent.computed;
      const isObjectKey =
        (parent?.type === "ObjectProperty" ||
          parent?.type === "ObjectMethod" ||
          parent?.type === "ClassProperty" ||
          parent?.type === "ClassMethod") &&
        parentKey === "key" &&
        !parent.computed;
      const isLabel =
        parentKey === "label" &&
        (parent?.type === "LabeledStatement" ||
          parent?.type === "BreakStatement" ||
          parent?.type === "ContinueStatement");
      const isJsxAttributeName = parent?.type === "JSXAttribute" && parentKey === "name";
      const isJsxIntrinsic =
        parent?.type === "JSXOpeningElement" && parentKey === "name" && /^[a-z]/.test(name);
      const isDeclarationId =
        parentKey === "id" &&
        (parent?.type === "FunctionDeclaration" ||
          parent?.type === "ClassDeclaration" ||
          parent?.type === "TSTypeAliasDeclaration" ||
          parent?.type === "TSInterfaceDeclaration" ||
          parent?.type === "TSEnumDeclaration");
      const isOptionalMarker = parent?.type === "OptionalMemberExpression" && parentKey === "property" && !parent.computed;
      const isTypeImportArgument = parent?.type === "TSImportType" && parentKey === "argument";

      if (
        isMemberProperty ||
        isObjectKey ||
        isLabel ||
        isJsxAttributeName ||
        isDeclarationId ||
        isOptionalMarker ||
        isTypeImportArgument
      ) {
        return;
      }
      if (isJsxIntrinsic) {
        return; // <div>, <span> — host elements, not globals
      }
      if (!isAllowedGlobal(name)) {
        violations.push({ kind: "global", name });
      }
      return;
    }

    if (node.type === "ImportCall") {
      violations.push({ kind: "dynamic-import", name: "import()" });
    } else if (
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      (node.callee as BabelNodeLike).type === "Import"
    ) {
      violations.push({ kind: "dynamic-import", name: "import()" });
    } else if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration"
    ) {
      violations.push({ kind: "import", name: "import" });
    } else if (node.type === "WithStatement") {
      violations.push({ kind: "with-statement", name: "with" });
    } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const property = node.property as BabelNodeLike | undefined;
      if (node.computed) {
        const literalName =
          property?.type === "StringLiteral" && typeof property.value === "string"
            ? property.value
            : undefined;
        if (literalName !== undefined && FORBIDDEN_MEMBER_NAMES.has(literalName)) {
          violations.push({ kind: "computed-access", name: literalName });
        } else if (literalName === undefined) {
          // dynamic member access cannot be proven safe — reject
          violations.push({ kind: "computed-access", name: "computed-access" });
        }
      } else if (property?.type === "Identifier" && typeof property.name === "string") {
        if (FORBIDDEN_MEMBER_NAMES.has(property.name)) {
          violations.push({ kind: "member", name: property.name });
        }
      }
    } else if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = (node.left ?? node.argument) as BabelNodeLike | undefined;
      if (target?.type === "Identifier" && typeof target.name === "string" && !declared.has(target.name)) {
        // writing to an undeclared identifier creates/mutates a realm global
        if (isAllowedGlobal(target.name)) {
          violations.push({ kind: "assignment", name: target.name });
        } else {
          violations.push({ kind: "global", name: target.name });
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(child, node, key);
    }
  };

  visit(ast);

  // dedupe identical violations, keep first-seen order
  const seen = new Set<string>();
  const unique = violations.filter((violation) => {
    const key = `${violation.kind}:${violation.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ok: unique.length === 0, violations: unique };
}
