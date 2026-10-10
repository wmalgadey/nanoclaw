/**
 * Registers the `container_configs.tailscale_socket` column via the
 * module-migration seam (`registerMigration` in `src/db/migrations/index.ts`)
 * instead of a numbered core migration file. Uniqueness is keyed on this
 * migration's `module:tailscale:...` name, not on an `NNN-*.ts` sequence
 * number, so this skill never has to coordinate a migration number against
 * upstream's own migration count — see the comment on `registerMigration`
 * for why that seam exists.
 *
 * Importing this file is what registers the migration. `../tailscale.js`
 * imports it for that side effect, and `src/modules/index.ts` imports
 * `../tailscale.js` for the same reason.
 *
 * That makes the modules barrel the only thing that puts this migration in
 * front of the runner — and `src/index.ts` is the only entry point that loads
 * the barrel. Every other caller of `runMigrations` (`pnpm run migrate`,
 * `setup/register.ts`, `setup/pair-*.ts`, `setup/migrate-v2/*`,
 * `scripts/init-*-agent.ts`) imports the migration list directly, registers no
 * module migrations at all, and reports "current" without having run this one.
 * So the column appears at the first HOST BOOT after install, not from a
 * standalone migrate.
 *
 * That is benign here and needs no fix: the only writer of the column is
 * `ncl groups config enable-tailscale`, which is served over the host's socket
 * and therefore can't be reached before the host has booted. The `up` below is
 * idempotent against a column that already exists, so ordering never matters.
 *
 * Do not "fix" this by importing the barrel from a migration entry point, or by
 * importing this file from `src/db/migrations/index.ts` — the latter deadlocks
 * on itself: ESM hoists the import above the module body, so `registerMigration`
 * would run while `moduleMigrations` is still in its temporal dead zone and
 * throw a ReferenceError at startup. Both would also be edits to upstream files
 * this skill does not own.
 */
import { registerMigration } from './index.js';

registerMigration({
  version: 1,
  name: 'module:tailscale:container-config-socket',
  async up(db) {
    try {
      await db.exec(`ALTER TABLE container_configs ADD COLUMN tailscale_socket INTEGER NOT NULL DEFAULT 0;`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Not needed on the normal path — `name` uniqueness already makes
      // registerMigration a run-once operation per schema_version row. This
      // guards the case where the column exists but wasn't recorded under
      // this name (e.g. carried over from before this seam existed).
      if (msg.includes('duplicate column') || msg.includes('already exists')) return;
      throw err;
    }
  },
});
