/**
 * Keys, certificates and password files: indexed by name only, so their text never reaches
 * the index, previews or MCP. Matched by name wherever they are, and, for plain text files, by
 * a private key block in the text itself.
 */
import { extOf, kindOf } from "../kinds.ts"

/** Folders that hold keys and logins. */
const SECRET_DIR = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker)(?:\/|$)/i

/**
 * Key stores, certificates and password databases. `.key` is left out: zsearch reads it as
 * Keynote, and a PEM key under that name is caught by its contents instead.
 */
const SECRET_EXTS = new Set([
  "pem", "p12", "pfx", "p8", "keystore", "jks", "bks", "ppk", "kdbx", "kdb", "gpg", "pgp", "asc",
  "crt", "cer", "der", "csr", "mobileprovision", "provisionprofile", "env",
])

/** Whole names: SSH keys, login files and environment files. */
const SECRET_NAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?|\.env(?:\..*)?|\.envrc|[._]netrc|\.npmrc|\.pypirc|\.pgpass|\.?htpasswd|\.git-credentials|credentials(?:\.json)?|client_secret.*\.json)$/i

/** Settings files named for what they hold ("secrets.yaml", "credentials.toml"). */
const SECRET_STEM = /^(?:secrets?|credentials?)(?:[._-]|$)/i

/** A file whose text zsearch never reads, by its path. */
export function secretFile(path: string): boolean {
  if (SECRET_DIR.test(path)) return true
  const name = path.slice(path.lastIndexOf("/") + 1)
  if (SECRET_EXTS.has(extOf(name)) || SECRET_NAME.test(name)) return true
  if (!SECRET_STEM.test(name)) return false
  const kind = kindOf(name)
  return kind === "data" || kind === "other"
}

/** The armor line of a private key: PEM, OpenSSH, PGP and PuTTY's own format. */
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|^PuTTY-User-Key-File-\d+:/m

/** Text that holds a private key, which is then not indexed. */
export function holdsPrivateKey(text: string): boolean {
  return (text.includes("PRIVATE KEY") || text.includes("PuTTY-User-Key-File")) && PRIVATE_KEY.test(text)
}

/**
 * As `holdsPrivateKey`, for a file's bytes (the armor reads the same in any ASCII-based
 * encoding). Every text file passes through here, so most are ruled out by a native search.
 */
export function bytesHoldPrivateKey(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.indexOf("PRIVATE KEY") < 0 && b.indexOf("PuTTY-User-Key-File") < 0) return false
  return PRIVATE_KEY.test(b.toString("latin1"))
}

/** Why such a file was not read, as status shows it. */
export const SECRET_NOTE = "secret"
