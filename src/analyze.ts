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
 * Parses each changed TypeScript file and returns every exported symbol whose
 * TSDoc is missing or judged incomplete by {@link isTsDocIncomplete}.
 *
 * Non-exported / private symbols are intentionally ignored — the Action only
 * enforces documentation on the public API surface of changed files.
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

    for (const fn of source.getFunctions()) {
      if (fn.isExported()) collect(fn, "function", file.path, violations);
    }

    for (const iface of source.getInterfaces()) {
      if (iface.isExported())
        collect(iface, "interface", file.path, violations);
    }

    for (const alias of source.getTypeAliases()) {
      if (alias.isExported())
        collect(alias, "type-alias", file.path, violations);
    }

    for (const cls of source.getClasses()) {
      if (!cls.isExported()) continue;
      collect(cls, "class", file.path, violations);

      for (const method of cls.getMethods()) {
        if (
          method.getScope() === "private" ||
          method.getScope() === "protected"
        )
          continue;
        collect(method, "method", file.path, violations);
      }
    }
  }

  return violations;
}

function collect(
  node: DocumentableNode,
  kind: Violation["kind"],
  filePath: string,
  out: Violation[],
): void {
  const jsDocs = node.getJsDocs();
  const name = getName(node);
  if (!name) return;

  if (!isTsDocIncomplete({ node, jsDocs, kind })) return;

  out.push({
    file: filePath,
    line: node.getStartLineNumber(),
    symbolName: name,
    kind,
    source: truncateForPrompt(node.getText()),
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
