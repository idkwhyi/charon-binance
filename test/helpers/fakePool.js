import { setPool } from '../../src/db/pg-connection.js';

/**
 * Install a fake pg pool. `respond(text, params)` returns the rows for a query.
 * Every call is recorded in the returned `calls` array.
 */
export function installFakePool(respond = () => []) {
  const calls = [];
  setPool({
    async query(text, params = []) {
      calls.push({ text, params });
      const rows = (await respond(text, params)) || [];
      return { rows, rowCount: rows.length };
    },
  });
  return calls;
}
