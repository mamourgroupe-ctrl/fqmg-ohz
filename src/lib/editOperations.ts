export type EditOperation = {
  description: string;
  old_string: string;
  new_string: string;
  lineNumber?: number;
};

// Normalize line endings to LF for consistent matching
export function normalizeLineEndings(str: string): string {
  return str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Calculate line number where a string occurs in code
export function getLineNumber(code: string, searchString: string): number {
  const normalizedCode = normalizeLineEndings(code);
  const normalizedSearch = normalizeLineEndings(searchString);
  const index = normalizedCode.indexOf(normalizedSearch);
  if (index === -1) return -1;
  return normalizedCode.substring(0, index).split("\n").length;
}

// Find all occurrences of a string in code
export function findAllMatches(code: string, searchString: string): number[] {
  const normalizedCode = normalizeLineEndings(code);
  const normalizedSearch = normalizeLineEndings(searchString);
  const matches: number[] = [];
  let index = normalizedCode.indexOf(normalizedSearch);
  while (index !== -1) {
    matches.push(index);
    index = normalizedCode.indexOf(normalizedSearch, index + 1);
  }
  return matches;
}

// Apply edit operations to code and enrich with line numbers
// Validates all edits against original code first, then applies atomically
export function applyEdits(
  code: string,
  edits: EditOperation[],
): {
  success: boolean;
  result: string;
  error?: string;
  enrichedEdits?: EditOperation[];
  failedEdit?: EditOperation;
} {
  const normalizedCode = normalizeLineEndings(code);

  // Phase 1: Validate all edits against the ORIGINAL code
  // This prevents partial application and ensures all old_strings exist in the original
  const validatedEdits: Array<EditOperation & { matchIndex: number }> = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const { old_string, new_string } = edit;
    const normalizedOldString = normalizeLineEndings(old_string);

    // Check if the old_string exists in original code
    if (!normalizedCode.includes(normalizedOldString)) {
      return {
        success: false,
        result: code,
        error: `Edit ${i + 1} failed: Could not find the specified text in the original code`,
        failedEdit: edit,
      };
    }

    // Check for multiple matches (ambiguous)
    const matches = findAllMatches(code, old_string);
    if (matches.length > 1) {
      return {
        success: false,
        result: code,
        error: `Edit ${i + 1} failed: Found ${matches.length} matches in the original code. The edit target is ambiguous. Include more surrounding context to make it unique.`,
        failedEdit: edit,
      };
    }

    // Store the match index for later application
    validatedEdits.push({
      ...edit,
      old_string: normalizedOldString,
      new_string: normalizeLineEndings(new_string),
      matchIndex: matches[0],
    });
  }

  // Phase 2: Check for overlapping edits
  // Sort by match index to detect overlaps
  const sortedEdits = [...validatedEdits].sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 0; i < sortedEdits.length - 1; i++) {
    const current = sortedEdits[i];
    const next = sortedEdits[i + 1];
    const currentEnd = current.matchIndex + current.old_string.length;
    if (currentEnd > next.matchIndex) {
      return {
        success: false,
        result: code,
        error: `Edit ${validatedEdits.indexOf(current) + 1} and edit ${validatedEdits.indexOf(next) + 1} overlap. Edits must target non-overlapping regions.`,
        failedEdit: current,
      };
    }
  }

  // Phase 3: Apply all edits atomically (from end to start to preserve indices)
  let result = normalizedCode;
  const enrichedEdits: EditOperation[] = [];

  // Apply in reverse order so earlier indices remain valid
  for (let i = validatedEdits.length - 1; i >= 0; i--) {
    const edit = validatedEdits[i];
    const { old_string, new_string, matchIndex } = edit;

    // Verify the old_string is still at the expected position
    if (!result.startsWith(old_string, matchIndex)) {
      return {
        success: false,
        result: code,
        error: `Edit ${i + 1} failed: Code shifted unexpectedly during application. This should not happen with atomic application.`,
        failedEdit: edit,
      };
    }

    // Apply the edit
    result =
      result.substring(0, matchIndex) +
      new_string +
      result.substring(matchIndex + old_string.length);

    // Calculate line number in the final result
    const lineNumber = getLineNumber(result, new_string);
    enrichedEdits.push({
      description: edit.description,
      old_string: edit.old_string,
      new_string: edit.new_string,
      lineNumber,
    });
  }

  // Reverse enrichedEdits to match original order
  enrichedEdits.reverse();

  return { success: true, result, enrichedEdits };
}