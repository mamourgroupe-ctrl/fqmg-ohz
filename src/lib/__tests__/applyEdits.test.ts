import { describe, it, expect } from "vitest";
import { applyEdits } from "../editOperations";

const sampleCode = `import { Img, staticFile, AbsoluteFill } from "remotion";
export const MyAnimation = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  
  // Constants
  const SCENE_DURATION = 60;
  const COLOR_TEXT = "#ffffff";
  const TITLE_TEXT = "Hello World";
  
  // Calculations
  const opacity = interpolate(frame, [0, SCENE_DURATION], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <div style={{ color: COLOR_TEXT, opacity }}>
        {TITLE_TEXT}
      </div>
    </AbsoluteFill>
  );
};`;

describe("applyEdits", () => {
  it("succeeds when old_string exists exactly once", () => {
    const edits = [
      {
        description: "Change text color",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
    ];
    
    const result = applyEdits(sampleCode, edits);
    expect(result.success).toBe(true);
    expect(result.result).toContain('const COLOR_TEXT = "#ff0000";');
    expect(result.result).not.toContain('const COLOR_TEXT = "#ffffff";');
    expect(result.enrichedEdits).toBeDefined();
    if (result.enrichedEdits) {
      expect(result.enrichedEdits).toHaveLength(1);
      expect(result.enrichedEdits[0].lineNumber).toBeGreaterThan(0);
    }
  });

  it("fails gracefully when old_string not found", () => {
    const edits = [
      {
        description: "Change non-existent text",
        old_string: 'const NON_EXISTENT = "value";',
        new_string: 'const NON_EXISTENT = "new";',
      },
    ];
    
    const result = applyEdits(sampleCode, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not find the specified text");
    expect(result.failedEdit).toBeDefined();
    expect(result.result).toBe(sampleCode); // Original code unchanged
  });

  it("fails when multiple matches exist (ambiguous)", () => {
    const codeWithDuplicates = `import { Img } from "remotion";
export const MyAnimation = () => {
  const COLOR_TEXT = "#ffffff";
  const COLOR_BG = "#ffffff";
  return <div>{COLOR_TEXT}</div>;
};`;
    
    const edits = [
      {
        description: "Change color - ambiguous",
        old_string: '#ffffff',
        new_string: '#ff0000',
      },
    ];
    
    const result = applyEdits(codeWithDuplicates, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain("matches");
    expect(result.error).toContain("ambiguous");
    expect(result.failedEdit).toBeDefined();
    expect(result.result).toBe(codeWithDuplicates); // Original code unchanged
  });

  it("applies multiple edits in order", () => {
    const edits = [
      {
        description: "Change text color",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
      {
        description: "Change title text",
        old_string: 'const TITLE_TEXT = "Hello World";',
        new_string: 'const TITLE_TEXT = "Bonjour Monde";',
      },
      {
        description: "Change scene duration",
        old_string: "const SCENE_DURATION = 60;",
        new_string: "const SCENE_DURATION = 90;",
      },
    ];
    
    const result = applyEdits(sampleCode, edits);
    expect(result.success).toBe(true);
    expect(result.result).toContain('const COLOR_TEXT = "#ff0000";');
    expect(result.result).toContain('const TITLE_TEXT = "Bonjour Monde";');
    expect(result.result).toContain("const SCENE_DURATION = 90;");
    expect(result.enrichedEdits).toBeDefined();
    if (result.enrichedEdits) {
      expect(result.enrichedEdits).toHaveLength(3);
    }
  });

  it("does not modify original code when edit fails", () => {
    const edits = [
      {
        description: "Valid edit first",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
      {
        description: "Invalid edit second",
        old_string: 'const DOES_NOT_EXIST = "value";',
        new_string: 'const DOES_NOT_EXIST = "new";',
      },
    ];
    
    const result = applyEdits(sampleCode, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not find");
    expect(result.result).toBe(sampleCode); // Original code completely unchanged
  });

  it("handles overlapping edits detection", () => {
    const code = `const A = 1;
const B = 2;
const C = 3;`;
    
    const edits = [
      {
        description: "Edit A and B",
        old_string: "const A = 1;\nconst B = 2;",
        new_string: "const A = 10;\nconst B = 20;",
      },
      {
        description: "Edit B and C (overlaps)",
        old_string: "const B = 2;\nconst C = 3;",
        new_string: "const B = 200;\nconst C = 300;",
      },
    ];
    
    const result = applyEdits(code, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain("overlap");
  });

  it("handles CRLF line endings correctly", () => {
    const codeWithCRLF = `import { Img } from "remotion";\r\nexport const MyAnimation = () => {\r\n  const COLOR_TEXT = "#ffffff";\r\n  return <div>{COLOR_TEXT}</div>;\r\n};`;
    
    const edits = [
      {
        description: "Change color with CRLF",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
    ];
    
    const result = applyEdits(codeWithCRLF, edits);
    expect(result.success).toBe(true);
    expect(result.result).toContain('const COLOR_TEXT = "#ff0000";');
  });

  it("handles LF line endings correctly", () => {
    const codeWithLF = `import { Img } from "remotion";
export const MyAnimation = () => {
  const COLOR_TEXT = "#ffffff";
  return <div>{COLOR_TEXT}</div>;
};`;
    
    const edits = [
      {
        description: "Change color with LF",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
    ];
    
    const result = applyEdits(codeWithLF, edits);
    expect(result.success).toBe(true);
    expect(result.result).toContain('const COLOR_TEXT = "#ff0000";');
  });

  it("detects exact whitespace matching requirement", () => {
    const code = `const  COLOR_TEXT  =  "#ffffff";  // extra spaces`;
    
    const edits = [
      {
        description: "Mismatched whitespace",
        old_string: 'const COLOR_TEXT = "#ffffff";', // normal spacing
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
    ];
    
    const result = applyEdits(code, edits);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not find");
  });

  it("preserves code structure after successful edits", () => {
    const edits = [
      {
        description: "Change multiple constants",
        old_string: 'const COLOR_TEXT = "#ffffff";',
        new_string: 'const COLOR_TEXT = "#ff0000";',
      },
      {
        description: "Change title",
        old_string: 'const TITLE_TEXT = "Hello World";',
        new_string: 'const TITLE_TEXT = "New Title";',
      },
    ];
    
    const result = applyEdits(sampleCode, edits);
    expect(result.success).toBe(true);
    
    // Verify structure preserved
    expect(result.result).toContain("import { Img, staticFile, AbsoluteFill } from \"remotion\";");
    expect(result.result).toContain("export const MyAnimation = () => {");
    expect(result.result).toContain("return (");
    expect(result.result).toContain("<AbsoluteFill");
    expect(result.result).toContain("</AbsoluteFill>");
    expect(result.result).toContain("};");
  });
});