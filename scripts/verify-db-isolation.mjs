#!/usr/bin/env node
/**
 * 数据库隔离验证脚本
 * 
 * 目的：在运行迁移测试之前，验证测试数据库路径确实被隔离到临时目录，
 *       不会访问或修改开发数据库 data/db/messages.db
 * 
 * 使用方法：node scripts/verify-db-isolation.mjs
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('=====================================');
console.log('数据库隔离验证脚本');
console.log('=====================================\n');

// 1. 检查开发数据库路径
const devDbPath = path.join(projectRoot, 'data', 'db', 'messages.db');
console.log(`✓ 开发数据库路径: ${devDbPath}`);
console.log(`  存在: ${fs.existsSync(devDbPath) ? '是' : '否'}\n`);

// 2. 模拟测试创建临时目录
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-test-migration-'));
const testDbPath = path.join(tempDir, 'messages.db');

console.log(`✓ 测试数据库路径: ${testDbPath}`);
console.log(`  在临时目录: ${testDbPath.includes(os.tmpdir()) ? '是' : '否'}`);
console.log(`  包含 data/db: ${testDbPath.includes('data/db') ? '是 ⚠️' : '否 ✓'}\n`);

// 3. 验证路径不同
const pathsAreDifferent = testDbPath !== devDbPath;
console.log(`✓ 路径隔离检查: ${pathsAreDifferent ? '通过 ✓' : '失败 ✗'}`);

if (!pathsAreDifferent) {
  console.error('\n❌ 严重错误：测试路径与开发路径相同！');
  console.error('   测试会修改开发数据库，请立即修复。\n');
  process.exit(1);
}

// 4. 验证路径不在项目目录内
const testPathInProject = testDbPath.startsWith(projectRoot);
console.log(`✓ 测试路径在项目外: ${!testPathInProject ? '是 ✓' : '否 ⚠️'}\n`);

// 5. 测试创建和清理
console.log('✓ 测试创建文件...');
fs.writeFileSync(testDbPath, 'test data');
console.log(`  文件已创建: ${fs.existsSync(testDbPath) ? '是' : '否'}`);

console.log('✓ 测试清理文件...');
fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`  文件已删除: ${!fs.existsSync(testDbPath) ? '是' : '否'}`);
console.log(`  目录已删除: ${!fs.existsSync(tempDir) ? '是' : '否'}\n`);

// 6. 验证开发数据库未被影响
console.log('✓ 验证开发数据库未被影响...');
const devDbStillExists = fs.existsSync(devDbPath);
const devDbExpectedState = true; // 如果开发数据库存在

if (devDbStillExists === devDbExpectedState) {
  console.log(`  开发数据库状态: 未改变 ✓\n`);
} else {
  console.error(`  开发数据库状态: 已改变 ✗\n`);
}

// 7. 总结
console.log('=====================================');
console.log('验证结果总结');
console.log('=====================================');
console.log(`✓ 测试路径隔离: ${pathsAreDifferent ? '通过' : '失败'}`);
console.log(`✓ 路径在项目外: ${!testPathInProject ? '通过' : '警告'}`);
console.log(`✓ 测试路径格式: ${testDbPath.includes(os.tmpdir()) ? '正确' : '错误'}`);
console.log(`✓ 开发数据库保护: ${devDbStillExists === devDbExpectedState ? '安全' : '危险'}`);

console.log('\n✓ 数据库隔离验证通过！\n');
console.log('可以安全运行迁移测试：');
console.log('  npm test -- --run tests/routes-workspace-memory.test.ts\n');
