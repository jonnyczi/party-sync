/**
 * Pin one fixture salt for the whole run.
 *
 * vitest forks a worker per test file and each inherits the parent env, so
 * setting this here (rather than as a module-level constant in helpers.ts)
 * guarantees every file generates fixtures from the same salt — while still
 * differing from the previous run, which matters because the copyparty volume
 * persists and the server now dedups. See RUN_SALT in ./helpers.ts.
 */
export default function setup() {
  if (!process.env.COPYPARTY_TEST_SALT) {
    process.env.COPYPARTY_TEST_SALT = String(Date.now() | 0);
  }
}
