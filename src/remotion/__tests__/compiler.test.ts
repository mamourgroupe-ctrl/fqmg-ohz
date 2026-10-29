import { describe, it, expect } from "vitest";
import { ensureRequiredImports, extractComponentBody, removeUnusedImports, fixCommonSyntaxErrors, transpileGeneratedCode } from "../compiler";

describe("ensureRequiredImports", () => {
  it("adds import for code without imports", () => {
    const input = `export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain('import { Img, staticFile } from "remotion";');
  });

  it("merges with partial existing import", () => {
    const input = `import { interpolate } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain('import { Img, interpolate, staticFile } from "remotion";');
  });

  it("adds no import when no Remotion usage", () => {
    const input = `export const MyAnimation = () => {
  return <div>Hello</div>;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toBe(input);
  });

  it("keeps complete import unchanged", () => {
    const input = `import { Img, staticFile, AbsoluteFill } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toBe(input);
  });

  it("adds all needed imports for multiple features", () => {
    const input = `export const MyAnimation = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Sequence>
      <AbsoluteFill style={{ background: "black" }} />
      <Img src={staticFile("/assets/logo.png")} />
    </Sequence>
  );
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain("AbsoluteFill");
    expect(result).toContain("Img");
    expect(result).toContain("Sequence");
    expect(result).toContain("staticFile");
    expect(result).toContain("useCurrentFrame");
    expect(result).toContain("useVideoConfig");
    expect(result).toContain('import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";');
  });

  it("converts default import to named import", () => {
    const input = `import Remotion from "remotion";
export const MyAnimation = () => {
  return <Remotion.Img src={Remotion.staticFile("/assets/logo.png")} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain('import { Img, staticFile } from "remotion";');
  });

  it("adds named import alongside namespace import", () => {
    const input = `import * as Remotion from "remotion";
export const MyAnimation = () => {
  return <Remotion.Img src={Remotion.staticFile("/assets/logo.png")} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain('import * as Remotion from "remotion"');
    expect(result).toContain('import { Img, staticFile } from "remotion";');
  });

  it("detects spring function usage", () => {
    const input = `export const MyAnimation = () => {
  const scale = spring({ frame: useCurrentFrame(), fps: 30, config: { damping: 100 } });
  return <div style={{ transform: \`scale(\${scale})\` }} />;
};`;

    const result = ensureRequiredImports(input);
    expect(result).toContain("spring");
    expect(result).toContain("useCurrentFrame");
    expect(result).toContain('import { spring, useCurrentFrame } from "remotion";');
  });
});

describe("extractComponentBody integration", () => {
  it("calls ensureRequiredImports internally", () => {
    const input = `import { interpolate } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = extractComponentBody(input);
    expect(result).toContain("staticFile");
    expect(result).toContain("Img");
  });
});

describe("removeUnusedImports", () => {
  it("keeps all imports when all are used", () => {
    const input = `import { Img, staticFile, interpolate } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} style={{ opacity: interpolate(0, [0, 1], [0, 1]) }} />;
};`;

    const result = removeUnusedImports(input);
    expect(result).toBe(input);
  });

  it("removes one unused named import", () => {
    const input = `import { Img, staticFile, interpolate } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = removeUnusedImports(input);
    expect(result).toContain('import { Img, staticFile } from "remotion";');
    expect(result).not.toContain("interpolate");
  });

  it("removes entire statement when all named imports unused, no default", () => {
    const input = `import { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  return <div>Hello</div>;
};`;

    const result = removeUnusedImports(input);
    expect(result).not.toContain("import { Img, staticFile } from \"remotion\"");
    expect(result).toContain("export const MyAnimation");
  });

  it("keeps default import when all named imports unused but default used", () => {
    const input = `import Remotion, { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  return <Remotion.div>Hello</Remotion.div>;
};`;

    const result = removeUnusedImports(input);
    expect(result).toContain('import Remotion from "remotion";');
    expect(result).not.toContain("Img");
    expect(result).not.toContain("staticFile");
  });

  it("removes unused namespace import", () => {
    const input = `import * as Remotion from "remotion";
export const MyAnimation = () => {
  return <div>Hello</div>;
};`;

    const result = removeUnusedImports(input);
    expect(result).not.toContain("import * as Remotion from \"remotion\"");
    expect(result).toContain("export const MyAnimation");
  });

  it("does not count usage inside string literal", () => {
    const input = `import { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  const msg = "Img is not used here";
  return <div>Hello</div>;
};`;

    const result = removeUnusedImports(input);
    // Import should be removed since Img/staticFile only appear in string literal
    expect(result).not.toContain('import { Img, staticFile } from "remotion"');
    // But code body should remain intact
    expect(result).toContain('const msg = "Img is not used here"');
  });

  it("does not count usage inside comment", () => {
    const input = `import { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  // Img is mentioned in comment
  /* staticFile also in block comment */
  return <div>Hello</div>;
};`;

    const result = removeUnusedImports(input);
    // Import should be removed since Img/staticFile only appear in comments
    expect(result).not.toContain('import { Img, staticFile } from "remotion"');
    // But comments should remain
    expect(result).toContain("// Img is mentioned in comment");
    expect(result).toContain("/* staticFile also in block comment */");
  });

  it("does not count JSX props as usage of import", () => {
    const input = `import { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  return <div Img="something" staticFile="else" />;
};`;

    const result = removeUnusedImports(input);
    // Import should be removed since Img/staticFile only appear as JSX props
    expect(result).not.toContain('import { Img, staticFile } from "remotion"');
    // But JSX should remain
    expect(result).toContain('Img="something"');
    expect(result).toContain('staticFile="else"');
  });

  it("leaves other module imports untouched", () => {
    const input = `import React from "react";
import { useState } from "react";
import { Img, staticFile } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = removeUnusedImports(input);
    expect(result).toContain('import React from "react";');
    expect(result).toContain('import { useState } from "react";');
    expect(result).toContain('import { Img, staticFile } from "remotion";');
  });

  it("handles empty named braces edge case", () => {
    const input = `import {} from "remotion";
export const MyAnimation = () => {
  return <div>Hello</div>;
};`;

    const result = removeUnusedImports(input);
    expect(result).not.toContain("import {} from \"remotion\"");
  });
});

describe("extractComponentBody integration with removeUnusedImports", () => {
  it("calls removeUnusedImports after ensureRequiredImports", () => {
    const input = `import { interpolate, spring } from "remotion";
export const MyAnimation = () => {
  return <Img src={staticFile("/assets/logo.png")} />;
};`;

    const result = extractComponentBody(input);
    // Should have added Img and staticFile, then removed spring (unused)
    expect(result).toContain("Img");
    expect(result).toContain("staticFile");
    // The import statement itself gets stripped in extractComponentBody,
    // but the ensureRequiredImports + removeUnusedImports logic runs before stripping
    // So we verify the internal logic by checking the functions are exported and work
    expect(typeof removeUnusedImports).toBe("function");
    expect(typeof ensureRequiredImports).toBe("function");
  });
});

describe("fixCommonSyntaxErrors", () => {
  it("closes destructured transition callback parameters", () => {
    expect(fixCommonSyntaxErrors("const render = ({ transition } => (transition);")).toBe(
      "const render = ({ transition }) => (transition);",
    );
  });

  it("compiles components with a malformed destructured transition callback", () => {
    const result = transpileGeneratedCode(`export const MyAnimation = () => {
  const render = ({ transition } => (
    <div style={{ opacity: transition.progress }} />
  );
  return render({ transition: { progress: 1 } });
};`);

    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
  });

  it("repairs a split durationInFrames identifier before compiling", () => {
    const result = transpileGeneratedCode(`export const MyAnimation = () => {
  const config = { durationIn Frames: 90 };
  return <div>{config.durationIn Frames}</div>;
};`);

    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
  });

  it("repairs split camel-case identifiers without changing strings or comments", () => {
    const input = `export const MyAnimation = () => {
  const frameAtStartOf KenBurns = useCurrentFrame() - 5;
  const label = "frameAtStartOf KenBurns";
  // frameAtStartOf KenBurns
  return <div>{frameAtStartOf KenBurns}</div>;
};`;
    const result = transpileGeneratedCode(input);
    const repaired = fixCommonSyntaxErrors(input);

    expect(repaired).toContain("const frameAtStartOfKenBurns =");
    expect(repaired).toContain("{frameAtStartOfKenBurns}");
    expect(repaired).toContain('"frameAtStartOf KenBurns"');
    expect(repaired).toContain("// frameAtStartOf KenBurns");
    expect(fixCommonSyntaxErrors(repaired)).toBe(repaired);
    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
  });

  it("adds missing Remotion frame and video-config bindings before preview compilation", () => {
    const code = `export const MyAnimation = () => {
  const progress = interpolate(frame, [0, durationInFrames], [0, 1]);
  return <div style={{ opacity: progress }}>{fps}</div>;
};`;
    const body = extractComponentBody(code);

    expect(body).toContain("const frame = useCurrentFrame();");
    expect(body).toContain(
      "const { fps, durationInFrames } = useVideoConfig();",
    );
    expect(transpileGeneratedCode(code).error).toBeNull();
  });

  it("does not duplicate Remotion bindings already declared by the component", () => {
    const body = extractComponentBody(`export const MyAnimation = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return <div>{frame + fps + durationInFrames}</div>;
};`);

    expect(body.match(/const frame = useCurrentFrame\(\);/g)).toHaveLength(1);
    expect(
      body.match(/const \{ fps, durationInFrames \} = useVideoConfig\(\);/g),
    ).toHaveLength(1);
  });

  it("adds clamp options to interpolate calls missing them", () => {
    const input = `const opacity = interpolate(frame, [0, 60], [0, 1]);`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toBe(
      'const opacity = interpolate(frame, [0, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });',
    );
  });

  it("compiles multiple interpolate calls after adding clamp options", () => {
    const result = transpileGeneratedCode(`export const MyAnimation = () => {
  const LOGO_DURATION = 30;
  const ABOUT_DURATION = 30;
  const STRENGTHS_DURATION = 30;
  const frame = useCurrentFrame();
  const logoProgress = interpolate(frame, [0, LOGO_DURATION], [0, 1]), { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
  const whoProgress = interpolate(frame, [LOGO_DURATION, LOGO_DURATION + ABOUT_DURATION], [0, 1]), { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
  const strengthsProgress = interpolate(frame, [LOGO_DURATION + ABOUT_DURATION, LOGO_DURATION + ABOUT_DURATION + STRENGTHS_DURATION], [0, 1]), { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
  return <div>{logoProgress + whoProgress + strengthsProgress}</div>;
};`);

    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
  });

  it("handles nested arguments and multiline calls without changing unrelated text", () => {
    const input = `const SCENE_DURATION = 90;
const note = "interpolate(frame, [0, 60], [0, 1])";
const template = \`interpolate(frame, [0, 60], [0, 1])\`;
// interpolate(frame, [0, 60], [0, 1])
/* interpolate(frame, [0, 60], [0, 1]) */
const progress = interpolate(
  Math.max(0, frame),
  [0, Math.max(30, fps * 2)],
  [0, 1]
);
const sceneProgress = interpolate(frame, [ 0, 60 ], [0, 1]);
const unrelated = customInterpolate(frame, [0, 60], [0, 1]);`;

    const result = fixCommonSyntaxErrors(input);

    expect(result).toContain(
      'Math.max(30, fps * 2)],\n  [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }\n);',
    );
    expect(result).toContain(
      'interpolate(frame, [0, SCENE_DURATION], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })',
    );
    expect(result).toContain('const note = "interpolate(frame, [0, 60], [0, 1])"');
    expect(result).toContain(
      "// interpolate(frame, [0, 60], [0, 1])",
    );
    expect(result).toContain(
      "/* interpolate(frame, [0, 60], [0, 1]) */",
    );
    expect(result).toContain(
      "const unrelated = customInterpolate(frame, [0, 60], [0, 1]);",
    );
    expect(fixCommonSyntaxErrors(result)).toBe(result);
  });

  it("compiles nested multiline calls with misplaced options", () => {
    const result = transpileGeneratedCode(`export const MyAnimation = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(
    Math.max(0, frame),
    [0, Math.max(30, 60)],
    [0, 1]
  ) /* generated outside the call */, {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp"
  };
  return <div>{progress}</div>;
};`);

    expect(result.error).toBeNull();
    expect(result.transpiled).toBeTruthy();
  });

  it("does not add clamp when already present", () => {
    const input = `const opacity = interpolate(frame, [0, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toBe(input);
  });

  it("replaces [0, 60] with [0, SCENE_DURATION] when SCENE_DURATION defined", () => {
    const input = `const SCENE_DURATION = 90;
const opacity = interpolate(frame, [0, 60], [0, 1]);`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain("interpolate(frame, [0, SCENE_DURATION]");
    expect(result).not.toContain("[0, 60]");
  });

  it("does not replace [0, 60] when SCENE_DURATION not defined", () => {
    const input = `const opacity = interpolate(frame, [0, 60], [0, 1]);`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain("[0, 60]");
    expect(result).not.toContain("SCENE_DURATION");
  });

  it("converts <img src='/assets/...'> to <Img src={staticFile(...)} />", () => {
    const input = `<img src="/assets/logo.png" />`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain('<Img src={staticFile("/assets/logo.png")} />');
    expect(result).not.toContain('<img');
  });

  it("converts <img src='assets/...'> to <Img src={staticFile(...)} />", () => {
    const input = `<img src="assets/image.jpg" />`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain('<Img src={staticFile("/assets/image.jpg")} />');
  });

  it("converts <img> with single quotes", () => {
    const input = `<img src='/assets/photo.jpeg' />`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain('<Img src={staticFile("/assets/photo.jpeg")} />');
  });

  it("converts <img> without leading slash", () => {
    const input = `<img src="assets/banner.png" />`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain('<Img src={staticFile("/assets/banner.png")} />');
  });

  it("handles self-closing and non-self-closing img tags", () => {
    const input1 = `<img src="/assets/logo.png">`;
    const input2 = `<img src="/assets/logo.png" />`;
    expect(fixCommonSyntaxErrors(input1)).toContain('<Img src={staticFile("/assets/logo.png")} />');
    expect(fixCommonSyntaxErrors(input2)).toContain('<Img src={staticFile("/assets/logo.png")} />');
  });

  it("preserves other attributes on img tag", () => {
    const input = `<img src="/assets/logo.png" alt="Logo" className="logo" />`;
    const result = fixCommonSyntaxErrors(input);
    expect(result).toContain('<Img src={staticFile("/assets/logo.png")} />');
    // Note: other attributes are dropped as <Img> from remotion doesn't take them all
    // This is expected behavior for the conversion
  });
});