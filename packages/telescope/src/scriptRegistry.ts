import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_ID = /^[a-z0-9][a-z0-9._-]*\.(?:mjs|js)$/i;

/** Lists trusted, provisioned ESM files without importing or executing their contents. */
export function listTrustedScripts(
  directory = process.env.TELESCOPE_SCRIPTS_DIR,
): Array<{ id: string; name: string; sha256: string }> {
  if (!directory) return [];
  const root = fs.realpathSync(path.resolve(directory));
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.length > 1000)
    throw new Error('The trusted script directory contains too many entries');
  return entries
    .filter(
      entry =>
        entry.isFile() && !entry.isSymbolicLink() && SCRIPT_ID.test(entry.name),
    )
    .map(entry => {
      const filename = path.join(root, entry.name);
      if (
        fs.realpathSync(filename) !== filename ||
        fs.statSync(filename).size > 1024 * 1024
      )
        throw new Error(
          `Registered script is invalid or too large: ${entry.name}`,
        );
      return {
        id: entry.name,
        name: entry.name.replace(/\.(?:mjs|js)$/i, ''),
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(filename))
          .digest('hex'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves one explicitly selected script and verifies its provisioned content version. */
export function resolveTrustedScript(
  id: string,
  expectedHash?: string,
  directory = process.env.TELESCOPE_SCRIPTS_DIR,
): { id: string; name: string; sha256: string; path: string } {
  if (!directory)
    throw new Error(
      'Set TELESCOPE_SCRIPTS_DIR to enable trusted script selection',
    );
  if (!SCRIPT_ID.test(id)) throw new Error('Invalid registered script ID');
  const script = listTrustedScripts(directory).find(item => item.id === id);
  if (!script) throw new Error('Registered script not found');
  if (expectedHash && expectedHash !== script.sha256)
    throw new Error(
      'The registered script changed; review and select its current version before running',
    );
  return {
    ...script,
    path: path.join(fs.realpathSync(path.resolve(directory)), id),
  };
}
