const { openPhase1Db } = require('../lib/phase1_db');
const { getPhase1Config } = require('../lib/phase1_config');

function main() {
  const config = getPhase1Config();
  const db = openPhase1Db();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log(JSON.stringify({
    ok: true,
    dbPath: config.dbPath,
    tables: tables.map(row => row.name),
  }, null, 2));
}

main();
