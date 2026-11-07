/** Separate local MySQL instance. Never touches the existing MySQL80 service. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(project, 'data', 'ecommerce-local');
const configPath = path.join(root, 'connection.json');
const port = 13317;
const base =
  process.env.MINICLAW_MYSQL_BASEDIR ||
  'C:\\Program Files\\MySQL\\MySQL Server 8.0';
const mysqld = path.join(base, 'bin', 'mysqld.exe');
const datadir = path.join(root, 'mysql');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : null;
async function assertIsolatedInstance(connection) {
  const [variables] = await connection.query('SELECT @@datadir AS datadir');
  if (
    path.resolve(variables[0].datadir).toLowerCase() !==
    path.resolve(datadir).toLowerCase()
  )
    throw new Error(
      'Unexpected MySQL data directory; refusing instance operation',
    );
}
if (process.argv[2] === 'stop') {
  if (!config)
    throw new Error('No isolated test instance has been initialized');
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    port,
    user: 'root',
    password: config.adminPassword,
  });
  let stoppedPid;
  try {
    await assertIsolatedInstance(connection);
    stoppedPid = Number(
      fs.readFileSync(path.join(root, 'mysql.pid'), 'utf8').trim(),
    );
    if (!Number.isSafeInteger(stoppedPid) || stoppedPid <= 0)
      throw new Error('Invalid isolated MySQL process ID; refusing shutdown');
    await connection.query('SHUTDOWN');
  } finally {
    await connection.end();
  }
  // SHUTDOWN acknowledges before Windows releases InnoDB files. Wait for exit
  // so a following start cannot race the previous process's file handles.
  for (let attempt = 0; ; attempt++) {
    try {
      process.kill(stoppedPid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') break;
      throw error;
    }
    if (attempt >= 120)
      throw new Error(
        'MySQL shutdown is still in progress; retry start after it exits',
      );
    await sleep(250);
  }
  console.log('Stopped the isolated ecommerce test MySQL instance.');
} else if (process.argv[2] === 'start') {
  if (!fs.existsSync(mysqld))
    throw new Error('MySQL 8 not found; set MINICLAW_MYSQL_BASEDIR');
  if (fs.existsSync(datadir) && !config)
    throw new Error(
      'Unconfigured data directory exists. Inspect it before retrying; no files were deleted.',
    );
  if (config) {
    try {
      const existing = await mysql.createConnection(config.url);
      try {
        await assertIsolatedInstance(existing);
        await existing.ping();
      } finally {
        await existing.end();
      }
      console.log('Isolated test database is already running.');
      process.exit(0);
    } catch {
      /* Start the previously configured instance. */
    }
  } else {
    fs.mkdirSync(datadir, { recursive: true });
    execFileSync(
      mysqld,
      [
        '--no-defaults',
        '--initialize-insecure',
        `--basedir=${base}`,
        `--datadir=${datadir}`,
      ],
      { windowsHide: true, timeout: 120_000, stdio: 'pipe' },
    );
  }
  const log = fs.openSync(path.join(root, 'mysql-start.log'), 'a');
  const child = spawn(
    mysqld,
    [
      '--no-defaults',
      `--basedir=${base}`,
      `--datadir=${datadir}`,
      '--bind-address=127.0.0.1',
      `--port=${port}`,
      '--mysqlx=OFF',
      `--pid-file=${path.join(root, 'mysql.pid')}`,
    ],
    { detached: true, windowsHide: true, stdio: ['ignore', log, log] },
  );
  child.unref();
  fs.closeSync(log);
  let admin;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      admin = await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: config?.adminPassword ?? '',
        connectTimeout: 1000,
      });
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!admin)
    throw new Error(
      'Test instance did not start. Inspect data/ecommerce-local/mysql-start.log; verify port 13317 is available.',
    );
  try {
    await assertIsolatedInstance(admin);
    if (!config) {
      const password = randomBytes(24).toString('hex');
      const adminPassword = randomBytes(24).toString('hex');
      await admin.query(
        'CREATE DATABASE miniclaw_ecommerce_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      );
      await admin.query(
        `CREATE USER 'miniclaw_test'@'localhost' IDENTIFIED BY ${mysql.escape(password)}`,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,INDEX ON miniclaw_ecommerce_test.* TO 'miniclaw_test'@'localhost'",
      );
      // Save the recovery credential before changing root authentication.
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            url: `mysql://miniclaw_test:${password}@127.0.0.1:${port}/miniclaw_ecommerce_test`,
            adminPassword,
          },
          null,
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
      await admin.query(
        `ALTER USER 'root'@'localhost' IDENTIFIED BY ${mysql.escape(adminPassword)}`,
      );
    }
  } finally {
    await admin.end();
  }
  console.log(
    'Started isolated MySQL on 127.0.0.1:13317. Credentials remain in gitignored data/ecommerce-local/connection.json.',
  );
} else throw new Error('Usage: node scripts/ecommerce-local.mjs start|stop');
