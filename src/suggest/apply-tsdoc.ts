/**
 * Splices a freshly-generated TSDoc block above the declaration at `line`,
 * replacing any existing JSDoc-style block comment that already sits
 * immediately above it.
 *
 * @remarks
 * Operates on the source string directly rather than going through ts-morph
 * because we only touch one doc block per call and need byte-exact preservation
 * of the rest of the file — ts-morph's `printer` would normalise trailing
 * whitespace and line endings, which pollutes the commit diff. Indentation is
 * matched to the declaration line so class methods render correctly.
 *
 * @param args.source - Full file content at the PR head SHA.
 * @param args.declarationLine - 1-indexed line of the symbol declaration
 *   itself (NOT including any existing JSDoc above it). Matches what
 *   `node.getStartLineNumber()` returns in `analyze.ts`.
 * @param args.tsdoc - The TSDoc block emitted by Claude (the full
 *   `slash-star-star ... star-slash` string), WITHOUT any leading
 *   indentation — the splice applies the declaration's indent.
 * @returns The new file content with the TSDoc block in place.
 */
export function spliceTsdocAboveDeclaration(args: {
  source: string;
  declarationLine: number;
  tsdoc: string;
}): string {
  const { source, declarationLine, tsdoc } = args;
  const lines = source.split("\n");
  const declIdx = declarationLine - 1;

  if (declIdx < 0 || declIdx >= lines.length) {
    throw new Error(
      `declarationLine ${declarationLine} is outside the source (1..${lines.length})`,
    );
  }

  const indent = leadingWhitespace(lines[declIdx]);
  const indentedBlock = tsdoc
    .split("\n")
    .map((l) => (l.length === 0 ? "" : `${indent}${l}`));

  const existingRange = findExistingJsDocRange(lines, declIdx);

  const before = lines.slice(
    0,
    existingRange ? existingRange.start : declIdx,
  );
  const after = lines.slice(declIdx);

  return [...before, ...indentedBlock, ...after].join("\n");
}

/**
 * Walks upward from the declaration line to find an existing JSDoc block
 * directly above it (ignoring blank lines in between).
 *
 * @remarks
 * Must tolerate blank lines because TypeScript style varies — some codebases
 * blank-line-separate the JSDoc from the declaration, others don't. Returns
 * `undefined` when nothing matches so the splice falls through to a pure
 * insert with no deletion.
 *
 * @returns `{ start, end }` as 0-indexed inclusive line indices when a
 *   JSDoc block is found; `undefined` otherwise.
 */
function findExistingJsDocRange(
  lines: string[],
  declIdx: number,
): { start: number; end: number } | undefined {
  let i = declIdx - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return undefined;

  if (!lines[i].trimEnd().endsWith("*/")) return undefined;
  const end = i;
  while (i >= 0 && !lines[i].trimStart().startsWith("/**")) i--;
  if (i < 0) return undefined;
  return { start: i, end };
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}
