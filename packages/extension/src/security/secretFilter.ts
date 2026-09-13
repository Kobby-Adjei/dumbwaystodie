/**
 * Secret filtering (spec §40).
 *
 * Runs on paths and filenames before anything leaves the machine. This is a
 * filename heuristic, not content scanning — it cannot catch a key pasted into
 * `index.html`. Content redaction is a later phase (spec §41); until then the
 * README says plainly what this does and does not cover.
 */

const SECRET_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".docker"]);

const SECRET_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "secrets",
  ".npmrc",
  ".netrc",
  ".pgpass",
]);

const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

export interface SecretFilterVerdict {
  blocked: boolean;
  /** Human-readable reason, safe to show in the panel and send as a note. */
  reason?: string;
}

function segmentsOf(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}

export function inspectPath(filePath: string): SecretFilterVerdict {
  const segments = segmentsOf(filePath);
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();

  for (const segment of segments.slice(0, -1)) {
    if (SECRET_DIRECTORIES.has(segment.toLowerCase())) {
      return { blocked: true, reason: `path is inside a ${segment} directory` };
    }
  }

  if (basename === ".env" || basename.startsWith(".env.")) {
    return { blocked: true, reason: "environment files can hold credentials" };
  }

  // id_rsa.pub is a public key, but denying it costs nothing and avoids
  // teaching the filter to reason about which half of a keypair it has.
  const withoutPub = basename.endsWith(".pub") ? basename.slice(0, -4) : basename;
  if (SECRET_BASENAMES.has(withoutPub)) {
    return { blocked: true, reason: `"${basename}" is a known credential filename` };
  }

  if (SECRET_EXTENSIONS.has(extensionOf(basename))) {
    return { blocked: true, reason: `"${extensionOf(basename)}" files commonly contain private keys` };
  }

  if (basename.includes("credential") || basename.includes("secret")) {
    return { blocked: true, reason: `"${basename}" looks like a credential file` };
  }

  return { blocked: false };
}

export function isLikelySecretPath(filePath: string): boolean {
  return inspectPath(filePath).blocked;
}
