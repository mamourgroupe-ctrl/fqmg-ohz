import { describe, expect, it } from "vitest";
import { extractComponentCode } from "@/helpers/sanitize-response";

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
});
