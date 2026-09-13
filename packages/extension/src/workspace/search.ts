/**
 * Search primitives (spec §15.5, §63).
 *
 * Pure functions, no filesystem and no vscode — the walking lives in the
 * workspace adapter, the matching lives here where it can be tested directly.
 *
 * Deliberate constraint: **the query is a literal string, never a regex.** A
 * provider-supplied pattern is untrusted input (spec §75), and an untrusted
 * regex is a denial-of-service waiting for a catastrophic backtrack. Literal
 * matching costs the coach very little and removes the whole class.
 */

export interface TextMatch {
  /** 1-based. */
  line: number;
  preview: string;
}

const MAX_PREVIEW_CHARACTERS = 200;

export function makePreview(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_PREVIEW_CHARACTERS
    ? `${trimmed.slice(0, MAX_PREVIEW_CHARACTERS)}…`
    : trimmed;
}

export function findMatchesInText(
  content: string,
  query: string,
  options: { caseSensitive?: boolean; maxMatches?: number } = {},
): TextMatch[] {
  if (query.length === 0) {
    return [];
  }

  const caseSensitive = options.caseSensitive ?? false;
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;
  const needle = caseSensitive ? query : query.toLowerCase();

  const matches: TextMatch[] = [];
  const lines = content.split(/\r\n|\r|\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const haystack = caseSensitive ? line : line.toLowerCase();

    if (haystack.includes(needle)) {
      matches.push({ line: index + 1, preview: makePreview(line) });
      if (matches.length >= maxMatches) {
        break;
      }
    }
  }

  return matches;
}

/* ------------------------------------------------------------------ *
 * Globs
 * ------------------------------------------------------------------ */

function escapeRegexChar(character: string): string {
  return /[\\^$.|+()[\]]/.test(character) ? `\\${character}` : character;
}

/**
 * Supports `**`, `*`, `?` and `{a,b}` alternation. Not a full glob
 * implementation, and deliberately not a dependency.
 *
 * `**` crosses directory separators; `*` and `?` do not.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let braceDepth = 0;

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];

    if (character === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          // `**/` also matches zero directories, so `**/*.ts` finds `a.ts`.
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      source += "[^/]";
    } else if (character === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (character === "," && braceDepth > 0) {
      source += "|";
    } else if (character !== undefined) {
      source += escapeRegexChar(character);
    }
  }

  return new RegExp(`^${source}$`);
}

/**
 * A pattern containing no `/` is matched against the basename too, so a coach
 * writing `*.ts` gets what it obviously meant rather than an empty result and
 * no explanation.
 */
export function matchesGlob(relativePath: string, glob: string): boolean {
  const pattern = globToRegExp(glob);
  if (pattern.test(relativePath)) {
    return true;
  }
  if (!glob.includes("/")) {
    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    return pattern.test(basename);
  }
  return false;
}

/** No globs means "search everything the ignore rules allow". */
export function matchesAnyGlob(relativePath: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  return globs.some((glob) => matchesGlob(relativePath, glob));
}
