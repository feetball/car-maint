import fs from 'node:fs';
import path from 'node:path';

// Default photo store: files live under <dataDir>/photos and are served by the
// app's /photos static mount. url is the relative path the client fetches.
export function createDiskStore({ dataDir }) {
  const dir = path.join(dataDir, 'photos');
  fs.mkdirSync(dir, { recursive: true });

  const full = (filename) => path.join(dir, path.basename(filename));

  return {
    kind: 'disk',
    dir,

    urlFor(filename) {
      return `/photos/${filename}`;
    },

    async put(filename, buffer /* , mimetype */) {
      fs.writeFileSync(full(filename), buffer);
      return { url: this.urlFor(filename) };
    },

    async read(filename) {
      return fs.readFileSync(full(filename));
    },

    async delete(filename) {
      try {
        fs.unlinkSync(full(filename));
      } catch {
        /* best-effort: already gone */
      }
    },

    async list() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      return names.filter((n) => {
        if (n.startsWith('.')) return false;
        try {
          return fs.statSync(path.join(dir, n)).isFile();
        } catch {
          return false;
        }
      });
    },
  };
}
