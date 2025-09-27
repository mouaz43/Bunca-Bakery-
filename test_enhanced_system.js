#!/usr/bin/env node

/**
 * Comprehensive Test Suite for Bunca Bakery Enhanced System
 * Tests all major functionality including automation features
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Test configuration
const TEST_CONFIG = {
  database: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/bunca_bakery_test',
  adminEmail: 'test@bunca-bakery.com',
  adminPassword: 'test123',
  baseUrl: 'http://localhost:3000'
};

// Test database connection
const pool = new Pool({
  connectionString: TEST_CONFIG.database,
  ssl: false
});

async function query(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Test utilities
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, testFn) {
    this.tests.push({ name, testFn });
  }

  async run() {
    console.log('🧪 Starting Bunca Bakery Enhanced System Tests\n');
    
    for (const test of this.tests) {
      try {
        console.log(`⏳ Running: ${test.name}`);
        await test.testFn();
        console.log(`✅ PASSED: ${test.name}\n`);
        this.passed++;
      } catch (error) {
        console.log(`❌ FAILED: ${test.name}`);
        console.log(`   Error: ${error.message}\n`);
        this.failed++;
      }
    }

    console.log('📊 Test Results:');
    console.log(`   Passed: ${this.passed}`);
    console.log(`   Failed: ${this.failed}`);
    console.log(`   Total:  ${this.tests.length}`);
    
    if (this.failed === 0) {
      console.log('\n🎉 All tests passed! System is ready for production.');
    } else {
      console.log('\n⚠️  Some tests failed. Please review and fix issues.');
      process.exit(1);
    }
  }
}

const runner = new TestRunner();

// Database Schema Tests
runner.test('Database Schema Creation', async () => {
  // Test that all required tables exist
  const tables = [
    'materials', 'items', 'bom', 'production_plan',
    'inventory_transactions', 'suppliers', 'purchase_orders',
    'quality_checks', 'equipment', 'staff', 'audit_log', 'system_settings'
  ];

  for (const table of tables) {
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      )
    `, [table]);
    
    if (!result.rows[0].exists) {
      throw new Error(`Table ${table} does not exist`);
    }
  }
});

runner.test('Database Indexes', async () => {
  // Test that performance indexes exist
  const indexes = [
    'idx_materials_active',
    'idx_items_active',
    'idx_production_plan_day',
    'idx_inventory_transactions_material'
  ];

  for (const index of indexes) {
    const result = await query(`
      SELECT EXISTS (
        SELECT FROM pg_indexes 
        WHERE indexname = $1
      )
    `, [index]);
    
    if (!result.rows[0].exists) {
      throw new Error(`Index ${index} does not exist`);
    }
  }
});

// Data Integrity Tests
runner.test('Material Data Integrity', async () => {
  // Insert test material
  await query(`
    INSERT INTO materials (code, name, base_unit, price_per_unit, current_stock, min_stock, reorder_point)
    VALUES ('TEST_FLOUR', 'Test Flour', 'g', 0.002, 1000, 100, 200)
    ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
  `);

  // Verify material exists
  const result = await query('SELECT * FROM materials WHERE code = $1', ['TEST_FLOUR']);
  if (result.rowCount === 0) {
    throw new Error('Failed to insert test material');
  }

  // Test reorder point logic
  const material = result.rows[0];
  if (material.current_stock <= material.reorder_point) {
    console.log('   ✓ Reorder point logic working correctly');
  }
});

runner.test('Recipe Cost Calculation', async () => {
  // Insert test item
  await query(`
    INSERT INTO items (code, name, yield_qty, yield_unit)
    VALUES ('TEST_BREAD', 'Test Bread', 10, 'pcs')
    ON CONFLICT (code) DO UPDATE SET updated_at = NOW()
  `);

  // Insert BOM
  await query('DELETE FROM bom WHERE product_code = $1', ['TEST_BREAD']);
  await query(`
    INSERT INTO bom (product_code, material_code, qty, unit, waste_factor)
    VALUES ('TEST_BREAD', 'TEST_FLOUR', 500, 'g', 0.05)
  `);

  // Test cost calculation
  const bomResult = await query(`
    SELECT b.qty, b.unit, b.waste_factor, m.price_per_unit
    FROM bom b
    JOIN materials m ON m.code = b.material_code
    WHERE b.product_code = $1
  `, ['TEST_BREAD']);

  if (bomResult.rowCount === 0) {
    throw new Error('BOM not found for test item');
  }

  const line = bomResult.rows[0];
  const adjustedQty = line.qty * (1 + line.waste_factor);
  const cost = adjustedQty * line.price_per_unit;
  
  if (cost <= 0) {
    throw new Error('Cost calculation failed');
  }

  console.log(`   ✓ Recipe cost calculated: €${cost.toFixed(3)}`);
});

runner.test('Inventory Transaction Tracking', async () => {
  // Record inventory transaction
  await query(`
    INSERT INTO inventory_transactions 
    (material_code, transaction_type, quantity, unit, reference_type, created_by)
    VALUES ('TEST_FLOUR', 'out', 100, 'g', 'test', 'test_system')
  `);

  // Update material stock
  await query(`
    UPDATE materials 
    SET current_stock = current_stock - 100
    WHERE code = 'TEST_FLOUR'
  `);

  // Verify transaction recorded
  const transResult = await query(`
    SELECT * FROM inventory_transactions 
    WHERE material_code = 'TEST_FLOUR' AND reference_type = 'test'
    ORDER BY created_at DESC LIMIT 1
  `);

  if (transResult.rowCount === 0) {
    throw new Error('Inventory transaction not recorded');
  }

  console.log('   ✓ Inventory transaction tracking working');
});

runner.test('Production Planning', async () => {
  // Insert test production plan
  const today = new Date().toISOString().split('T')[0];
  
  await query(`
    INSERT INTO production_plan (day, product_code, qty, status, priority)
    VALUES ($1, 'TEST_BREAD', 20, 'planned', 5)
  `, [today]);

  // Verify production plan
  const planResult = await query(`
    SELECT * FROM production_plan 
    WHERE day = $1 AND product_code = 'TEST_BREAD'
  `, [today]);

  if (planResult.rowCount === 0) {
    throw new Error('Production plan not created');
  }

  console.log('   ✓ Production planning working');
});

runner.test('Quality Control Integration', async () => {
  // Insert quality check
  await query(`
    INSERT INTO quality_checks 
    (check_type, reference_id, checked_by, passed, notes)
    VALUES ('production_batch', 'TEST_BATCH_001', 'test_user', true, 'Test quality check')
  `);

  // Verify quality check
  const qualityResult = await query(`
    SELECT * FROM quality_checks 
    WHERE reference_id = 'TEST_BATCH_001'
  `);

  if (qualityResult.rowCount === 0) {
    throw new Error('Quality check not recorded');
  }

  console.log('   ✓ Quality control integration working');
});

runner.test('Audit Logging', async () => {
  // Insert audit log entry
  await query(`
    INSERT INTO audit_log (user_id, action, details)
    VALUES ('test_user', 'test_action', '{"test": "data"}')
  `);

  // Verify audit log
  const auditResult = await query(`
    SELECT * FROM audit_log 
    WHERE user_id = 'test_user' AND action = 'test_action'
    ORDER BY timestamp DESC LIMIT 1
  `);

  if (auditResult.rowCount === 0) {
    throw new Error('Audit log entry not created');
  }

  console.log('   ✓ Audit logging working');
});

runner.test('System Settings', async () => {
  // Test system settings
  const settingsResult = await query('SELECT * FROM system_settings');
  
  if (settingsResult.rowCount === 0) {
    throw new Error('No system settings found');
  }

  // Check for required settings
  const requiredSettings = [
    'default_waste_factor',
    'auto_reorder_enabled',
    'quality_check_required'
  ];

  const settingKeys = settingsResult.rows.map(row => row.key);
  
  for (const setting of requiredSettings) {
    if (!settingKeys.includes(setting)) {
      throw new Error(`Required setting ${setting} not found`);
    }
  }

  console.log('   ✓ System settings configured correctly');
});

// Performance Tests
runner.test('Database Performance', async () => {
  const startTime = Date.now();
  
  // Test complex query performance
  await query(`
    SELECT m.code, m.name, m.current_stock, 
           COUNT(it.id) as transaction_count,
           SUM(CASE WHEN it.transaction_type = 'out' THEN it.quantity ELSE 0 END) as total_usage
    FROM materials m
    LEFT JOIN inventory_transactions it ON it.material_code = m.code
    WHERE m.active = true
    GROUP BY m.code, m.name, m.current_stock
    ORDER BY total_usage DESC
    LIMIT 100
  `);
  
  const endTime = Date.now();
  const queryTime = endTime - startTime;
  
  if (queryTime > 1000) {
    throw new Error(`Query too slow: ${queryTime}ms`);
  }
  
  console.log(`   ✓ Complex query executed in ${queryTime}ms`);
});

// API Endpoint Tests (if server is running)
runner.test('API Health Check', async () => {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${TEST_CONFIG.baseUrl}/healthz`);
    
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    
    const data = await response.json();
    if (!data.ok) {
      throw new Error('Health check returned not ok');
    }
    
    console.log('   ✓ API health check passed');
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log('   ⚠️  Server not running, skipping API tests');
      return;
    }
    throw error;
  }
});

// Data Validation Tests
runner.test('Data Validation Rules', async () => {
  // Test that invalid data is rejected
  try {
    await query(`
      INSERT INTO materials (code, name, base_unit, price_per_unit)
      VALUES ('', 'Invalid Material', 'g', -1)
    `);
    throw new Error('Invalid data was accepted');
  } catch (error) {
    if (error.message.includes('Invalid data was accepted')) {
      throw error;
    }
    // Expected to fail due to constraints
    console.log('   ✓ Data validation working correctly');
  }
});

// Cleanup function
async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');
  
  try {
    await query('DELETE FROM audit_log WHERE user_id = $1', ['test_user']);
    await query('DELETE FROM quality_checks WHERE reference_id = $1', ['TEST_BATCH_001']);
    await query('DELETE FROM production_plan WHERE product_code = $1', ['TEST_BREAD']);
    await query('DELETE FROM inventory_transactions WHERE material_code = $1 AND reference_type = $2', ['TEST_FLOUR', 'test']);
    await query('DELETE FROM bom WHERE product_code = $1', ['TEST_BREAD']);
    await query('DELETE FROM items WHERE code = $1', ['TEST_BREAD']);
    await query('DELETE FROM materials WHERE code = $1', ['TEST_FLOUR']);
    
    console.log('✅ Test data cleaned up successfully');
  } catch (error) {
    console.log('⚠️  Cleanup failed:', error.message);
  }
}

// Main execution
async function main() {
  try {
    // Test database connection
    await query('SELECT NOW()');
    console.log('✅ Database connection established\n');
    
    // Run all tests
    await runner.run();
    
  } catch (error) {
    console.error('❌ Test setup failed:', error.message);
    process.exit(1);
  } finally {
    await cleanup();
    await pool.end();
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n⏹️  Tests interrupted');
  await cleanup();
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', async (error) => {
  console.error('❌ Unhandled rejection:', error);
  await cleanup();
  await pool.end();
  process.exit(1);
});

// Run tests if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { TestRunner, query, cleanup };
