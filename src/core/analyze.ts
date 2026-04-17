import { Project, Node, JSDoc, SyntaxKind } from "ts-morph";
import type {
  FunctionDeclaration,
  ClassDeclaration,
  MethodDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
} from "ts-morph";

import type { ChangedFile, Violation } from "./types";
import { isTsDocIncomplete } from "./tsdoc-rules";
import {
  classifyWhy,
  DEFAULT_WHY_RULES_CONFIG,
  type WhyRulesConfig,
} from "./why-rules";

type DocumentableNode =
  | FunctionDeclaration
  | ClassDeclaration
  | MethodDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration;

/**
 * Parses each changed TypeScript file and returns every top-level symbol that
 * fails the structural TSDoc check {@link isTsDocIncomplete} OR the
 * why-acceptance predicate {@link hasAcceptableRemarks}.
 *
 * @remarks
 * Checks every top-level function, class, interface, and type alias regardless
 * of whether it's `export`ed — internal helpers need docs too. For class
 * bodies only public methods are checked; private/protected methods are
 * intentionally skipped because the why for an internal helper rarely needs
 * to be defended in the same way as a public surface.
 *
 * @param files - Changed TypeScript files at the PR head SHA.
 * @param whyConfig - Optional override for the why-acceptance predicate's
 *   word-count threshold and keyword set. Defaults to
 *   {@link DEFAULT_WHY_RULES_CONFIG}; the report variant wires this to
 *   `min-remarks-words` and `why-keywords` action inputs.
 * @returns Every symbol with at least one failing signal, populated with both
 *   `structuralIncomplete` and `whyStatus` so the renderer can show targeted
 *   reasons per symbol.
 */
export function findUndocumentedSymbols(
  files: ChangedFile[],
  whyConfig: WhyRulesConfig = DEFAULT_WHY_RULES_CONFIG,
): Violation[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });

  const violations: Violation[] = [];

  for (const file of files) {
    const source = project.createSourceFile(file.path, file.content, {
      overwrite: true,
    });
    const lines = file.content.split("\n");

    const ctx: CollectCtx = {
      filePath: file.path,
      lines,
      out: violations,
      whyConfig,
    };

    for (const fn of source.getFunctions()) {
      collect(fn, "function", ctx);
    }

    for (const iface of source.getInterfaces()) {
      collect(iface, "interface", ctx);
    }

    for (const alias of source.getTypeAliases()) {
      collect(alias, "type-alias", ctx);
    }

    for (const cls of source.getClasses()) {
      collect(cls, "class", ctx);

      for (const method of cls.getMethods()) {
        if (
          method.getScope() === "private" ||
          method.getScope() === "protected"
        )
          continue;
        collect(method, "method", ctx);
      }
    }
  }

  return violations;
}

interface CollectCtx {
  filePath: string;
  lines: string[];
  out: Violation[];
  whyConfig: WhyRulesConfig;
}

function collect(
  node: DocumentableNode,
  kind: Violation["kind"],
  ctx: CollectCtx,
): void {
  const jsDocs = node.getJsDocs();
  const name = getName(node);
  if (!name) return;

  const structuralIncomplete = isTsDocIncomplete({ node, jsDocs, kind });
  const remarksText = extractRemarksText(jsDocs);
  const why = classifyWhy(remarksText);

  // A symbol is only reported when at least one signal fails. A symbol with
  // complete structural TSDoc and an acceptable @remarks is silently passing.
  if (!structuralIncomplete && why.status === "ok") return;

  const line = node.getStartLineNumber();
  // `lines` is 0-indexed; `line` is 1-indexed. Fallback to empty string
  // guards against rare mismatches (e.g. trailing newline handling).
  const originalLine = ctx.lines[line - 1] ?? "";

  ctx.out.push({
    file: ctx.filePath,
    line,
    symbolName: name,
    kind,
    source: truncateForPrompt(node.getText()),
    originalLine,
    structuralIncomplete,
    whyStatus: why.status,
    whyFailureReason: why.reason,
  });
}

/**
 * Returns the prose body of the symbol's `@remarks` tag, or `undefined` when
 * no such tag exists. Concatenates with a single space when an author has
 * (legally) split the why across multiple `@remarks` blocks on the same
 * symbol — the predicate operates on the full prose.
 */
function extractRemarksText(jsDocs: JSDoc[]): string | undefined {
  if (!jsDocs.length) return undefined;
  const parts: string[] = [];
  for (const doc of jsDocs) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() !== "remarks") continue;
      const comment = (tag.getCommentText() ?? "").trim();
      if (comment) parts.push(comment);
    }
  }
  if (!parts.length) return undefined;
  return parts.join(" ");
}

function getName(node: DocumentableNode): string | undefined {
  // All five node types expose getName(), but MethodDeclaration can technically
  // be a computed name — we skip those since they can't be documented by name.
  if (Node.isMethodDeclaration(node)) {
    const nameNode = node.getNameNode();
    if (nameNode.getKind() === SyntaxKind.ComputedPropertyName)
      return undefined;
  }
  return node.getName();
}

/**
 * Truncates a symbol's source to keep the prompt small. For very long
 * functions we only need the signature + first few lines of the body for
 * Claude to understand intent.
 */
function truncateForPrompt(src: string): string {
  const MAX = 2000;
  if (src.length <= MAX) return src;
  return `${src.slice(0, MAX)}\n// ... (truncated for brevity)`;
}

export type { DocumentableNode, JSDoc };
