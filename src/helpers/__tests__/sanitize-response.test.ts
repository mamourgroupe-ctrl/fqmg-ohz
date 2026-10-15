import { describe, expect, it } from "vitest";
import {
  extractComponentCode,
  prepareGeneratedCode,
  stripMarkdownFences,
  validateGptResponse,
} from "@/helpers/sanitize-response";

describe("extractComponentCode", () => {
  it("removes a standalone trailing placeholder and duplicate component closer", () => {
    const code = `import React from "react";
export const Animation = (props) => {
  return <div>{props.title}</div>;
};
...
};`;

    expect(extractComponentCode(code)).toBe(`import React from "react";
export const Animation = (props) => {
  return <div>{props.title}</div>;
};`);
  });

  it("preserves valid spread syntax when no trailing placeholder exists", () => {
    const code = `import React from "react";
export const Animation = (props) => {
  const style = { ...props.style };
  return <div style={style}>...</div>;
};`;

    expect(extractComponentCode(code)).toBe(code);
  });

  it("extracts fenced code and repairs a malformed default export", () => {
    const response = `Here is the component:
\`\`\`tsx
import React from "react";
function Message() {
  return <div>Hello</div>;
}
default Message;
\`\`\`
---
Additional explanation`;

    const code = extractComponentCode(stripMarkdownFences(response));

    expect(code).toBe(`import React from "react";
function Message() {
  return <div>Hello</div>;
}
export default Message;`);
  });

  it("prepares malformed default syntax before validating a completed response", () => {
    const response = `import { AbsoluteFill } from "remotion";
export const MyAnimation = () => {
  return <AbsoluteFill />;
};
default MyAnimation;`;

    const code = prepareGeneratedCode(response);

    expect(code).toBe(`import { AbsoluteFill } from "remotion";
export const MyAnimation = () => {
  return <AbsoluteFill />;
};`);
    expect(code).not.toContain("default MyAnimation;");
    expect(validateGptResponse(code)).toEqual({ isValid: true, error: null });
  });
});
