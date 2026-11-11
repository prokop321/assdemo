# Asscat demo on a mock OS

Browser demo of `asscat-cli` as described in `asscat-demo-spec` (stav 2026-11-11), running on a small
simulated unix-like OS instead of a real Mac. No real files are touched.

**Run:** open `index.html` in a browser (works from `file://`, no server, no build), or use the single
file `dist/asscat-demo.html` (`node build.js` regenerates it).

- left: terminal (`help`, `asscat help`, `demo`, `selftest`), Tab completion, ↑/↓ history
- right: an independent Finder-like browser on the same disks (drag to move, double-click to edit,
  plug in / eject disks)
- state is kept in the browser's localStorage; `reset` starts over

**Tests:** `node tests/run.js [n]` runs the 22 acceptance scenarios from spec ch. 10 (also `selftest`
in the browser). `node tests/demos.js [name]` prints a transcript of the guided demos.

## Layout

| File | What |
|---|---|
| `src/os.js` | mock kernel: volumes with fs profiles (apfs, apfs-cs, hfs, exfat, msdos, smbfs), inodes, mounts at `/Volumes/…`, mtime granularity and local-time storage on FAT/exFAT, timezone, `rename` with no-replace, flock, processes, read counter |
| `src/asscat.js` | the app: DB (ch. 3), open/lock/backups/sync (ch. 4), tags/search (ch. 5), views (ch. 6), materialize/undo/recovery (ch. 7), CLI (ch. 8) |
| `src/shell.js` | shell: `ls cd tree mv cp rm mkdir touch chmod ln cat stat find`, `disk`, `clock`, `tz`, `holdlock`, `genphotos`… |
| `src/demos.js` | six guided walkthroughs (`demo tour`, `edits`, `card`, `views`, `crash`, `limits`; run in that order) |
| `src/selftest.js` | the spec's acceptance tests |
| `src/ui.js`, `index.html` | browser UI |

## What the simulation simplifies

- SHA-256 stands in for BLAKE3; the "SQLite" database is JSON in `.asscat/library.db`, rewritten on every
  commit (so a crash loses exactly the uncommitted part, like a transaction).
- Mock files are small strings, so the partial hash usually covers the whole file.
- Commands run one at a time; lock contention is shown with `holdlock` (a second process that keeps the
  lock), crashes with the debug flag `asscat --crash-after N materialize … --apply`.
- `apfs-cs` names are byte-exact (like ext4). Real case-sensitive APFS is normalization-insensitive, so
  scenario 16 (NFC and NFD "Střih" side by side) can't happen on a real Mac disk.
- `import`, `check`, `shoots` and the import filter are re-implemented from their description; the
  original Rust code wasn't available.

## Spec issues found while building

1. **Scenario 2 says `search a` finds the moved file, but 5.5 drops words shorter than 2 characters.**
   The test uses a folder named `alfa` instead.
2. **After "save over original" (4.5, `changed`), the old version keeps its tags but has no active path
   and no history row.** Its tags are still inherited by the new version, but `tag remove` only works on
   the original (5.3), and the original can't be selected by any selector. Result: an inherited tag on an
   overwritten file can't be removed. Fix: give the old version a history row for that path, or let
   `tag remove` act on ancestors.
3. A file that's moved *and* renamed between syncs isn't recognised as a move (step 4 needs the same
   name). It still keeps its identity, because it gets re-hashed onto the same `files` row. If it's also
   edited in that window, the link is lost: new file, old path only in history, no edge (`demo limits`
   shows this).
4. With `--rename-conflicts`, a target held on disk by a file that doesn't move still gives
   `stay:conflict` (7.3, first bullet). Implemented as written, but users may expect a rename there too.
