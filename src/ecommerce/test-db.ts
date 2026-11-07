import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';

/** Deliberately local and test-only. This is NOT a production connector. */
export function createCommercePool(
  url = process.env.MINICLAW_ECOMMERCE_TEST_URL,
): Pool {
  if (!url)
    throw new Error(
      'ecommerce_not_configured: set MINICLAW_ECOMMERCE_TEST_URL',
    );
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'mysql:' ||
    parsed.search ||
    parsed.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    !/^\/miniclaw_ecommerce(?:_[a-z0-9]+)*_test$/.test(parsed.pathname)
  ) {
    throw new Error(
      'test_database_required: only a local miniclaw_ecommerce*_test database is allowed',
    );
  }
  return mysql.createPool({
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit: 5,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

export type Sql = Pick<PoolConnection, 'execute'>;
export async function rows<T>(
  db: Sql,
  sql: string,
  params: Array<string | number | boolean | null> = [],
): Promise<T[]> {
  const [result] = await db.execute<RowDataPacket[]>(sql, params);
  return result as T[];
}
export async function transaction<T>(
  pool: Pool,
  run: (db: PoolConnection) => Promise<T>,
): Promise<T> {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const result = await run(db);
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

const tables = [
  `CREATE TABLE IF NOT EXISTS ec_products (
    workspace VARCHAR(160) NOT NULL, sku VARCHAR(80) NOT NULL, name VARCHAR(200) NOT NULL,
    category VARCHAR(80), cost_cents INT UNSIGNED NOT NULL, price_cents INT UNSIGNED NOT NULL,
    stock INT UNSIGNED NOT NULL, safety_stock INT UNSIGNED NOT NULL, version INT NOT NULL DEFAULT 1,
    source VARCHAR(160) NOT NULL, collected_at VARCHAR(32) NOT NULL, context_json JSON,
    is_low_stock BOOLEAN GENERATED ALWAYS AS (stock < safety_stock) STORED,
    PRIMARY KEY(workspace,sku), INDEX low_stock_lookup(workspace,is_low_stock,sku),
    INDEX category_lookup(workspace,category,sku))`,
  `CREATE TABLE IF NOT EXISTS ec_orders (
    workspace VARCHAR(160) NOT NULL, order_id VARCHAR(96) NOT NULL, sku VARCHAR(80) NOT NULL,
    payload JSON NOT NULL, PRIMARY KEY(workspace,order_id), INDEX sku_lookup(workspace,sku))`,
  `CREATE TABLE IF NOT EXISTS ec_competitors (
    workspace VARCHAR(160) NOT NULL, sku VARCHAR(80) NOT NULL, competitor VARCHAR(160) NOT NULL,
    payload JSON NOT NULL, PRIMARY KEY(workspace,sku,competitor))`,
  `CREATE TABLE IF NOT EXISTS ec_workflows (
    workspace VARCHAR(160) NOT NULL, id VARCHAR(96) NOT NULL, revision INT NOT NULL,
    state_json JSON NOT NULL, PRIMARY KEY(workspace,id))`,
  `CREATE TABLE IF NOT EXISTS ec_workflow_versions (
    workspace VARCHAR(160) NOT NULL, id VARCHAR(96) NOT NULL, revision INT NOT NULL,
    state_json JSON NOT NULL, created_at VARCHAR(32) NOT NULL,
    PRIMARY KEY(workspace,id,revision))`,
  `CREATE TABLE IF NOT EXISTS ec_approvals (
    workspace VARCHAR(160) NOT NULL, id VARCHAR(96) NOT NULL, workflow_id VARCHAR(96) NOT NULL,
    revision INT NOT NULL DEFAULT 1, status VARCHAR(32) NOT NULL, spec JSON NOT NULL,
    history JSON NOT NULL, created_at VARCHAR(32) NOT NULL, expires_at VARCHAR(32) NOT NULL,
    PRIMARY KEY(workspace,id), INDEX workflow_lookup(workspace,workflow_id))`,
  `CREATE TABLE IF NOT EXISTS ec_executions (
    workspace VARCHAR(160) NOT NULL, request_key VARCHAR(96) NOT NULL,
    approval_id VARCHAR(96) NOT NULL, fingerprint CHAR(64) NOT NULL, result_json JSON NOT NULL,
    PRIMARY KEY(workspace,request_key), UNIQUE KEY once_per_approval(workspace,approval_id))`,
  `CREATE TABLE IF NOT EXISTS ec_purchase_orders (
    workspace VARCHAR(160) NOT NULL, id VARCHAR(96) NOT NULL, approval_id VARCHAR(96) NOT NULL,
    sku VARCHAR(80) NOT NULL, quantity INT UNSIGNED NOT NULL, cost_cents INT UNSIGNED NOT NULL,
    supplier_id VARCHAR(80) NOT NULL, status VARCHAR(20) NOT NULL,
    created_at VARCHAR(32) NOT NULL, PRIMARY KEY(workspace,id),
    UNIQUE KEY once_per_approval(workspace,approval_id))`,
  `CREATE TABLE IF NOT EXISTS ec_receipts (
    workspace VARCHAR(160) NOT NULL, request_key VARCHAR(96) NOT NULL,
    purchase_order_id VARCHAR(96) NOT NULL, result_json JSON NOT NULL,
    PRIMARY KEY(workspace,request_key), UNIQUE KEY once_per_order(workspace,purchase_order_id))`,
  `CREATE TABLE IF NOT EXISTS ec_inventory_ledger (
    workspace VARCHAR(160) NOT NULL, id VARCHAR(96) NOT NULL, purchase_order_id VARCHAR(96) NOT NULL,
    sku VARCHAR(80) NOT NULL, delta INT NOT NULL, stock_before INT NOT NULL, stock_after INT NOT NULL,
    actor VARCHAR(96) NOT NULL, created_at VARCHAR(32) NOT NULL,
    PRIMARY KEY(workspace,id), UNIQUE KEY once_per_order(workspace,purchase_order_id))`,
];

export async function initializeCommerceSchema(pool: Pool): Promise<void> {
  for (const ddl of tables)
    await pool.execute(
      `${ddl} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    );
}
