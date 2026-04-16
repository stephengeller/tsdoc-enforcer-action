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

type DocumentableNode =
  | FunctionDeclaration
  | ClassDeclaration
  | MethodDeclaration
  | InterfaceDeclaration
  | TypeAliasDeclaration;

/**
 * Parses each changed TypeScript file and returns every top-level symbol whose
 * TSDoc is missing or judged incomplete by {@link isTsDocIncomplete}.
 *
 * Checks every top-level function, class, interface, and type alias regardless
 * of whether it's `export`ed — internal helpers need docs too. For class
 * bodies only public methods are checked; private/protected methods are
 * intentionally skipped.
 */
export function findUndocumentedSymbols(files: ChangedFile[]): Violation[] {
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

    const ctx: CollectCtx = { filePath: file.path, lines, out: violations };

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
}

function collect(
  node: DocumentableNode,
  kind: Violation["kind"],
  ctx: CollectCtx,
): void {
  const jsDocs = node.getJsDocs();
  const name = getName(node);
  if (!name) return;

  if (!isTsDocIncomplete({ node, jsDocs, kind })) return;

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
  });
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
