// The publish manifest's one number.
//
// Four gates used to spell `58` out by hand: the build could stage a correct tree and
// still fail, or worse, a new module could ship without anyone noticing the count was
// stale. Adding a file under `files` now means bumping exactly one place.
//
// What counts: every file the package ships — `index.mjs`, `client.js`, `bin/` (2),
// `lib/**` (compiled), `locale/`, `docs/`, plus the metadata files named in
// `package.json.files`. Compiled from `src/`, so the number moves when a source module
// is added or removed.
export const EXPECTED_DIST_FILES = 63;

/** How to fix this when a build reports `dist 文件数不匹配`. */
export const PUBLISH_ENTRY_COUNT_HINT =
  "跑 `node scripts/build.mjs` 看实际文件数；确认新文件确实属于发布面后，才改 EXPECTED_DIST_FILES。";
