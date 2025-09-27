#!/usr/bin/env node

// Simple start script to handle deployment issues
// This ensures the server starts correctly regardless of command variations

console.log('🍞 Bunca Bakery - Starting automated system...');

try {
  // Import and start the main server
  require('./server.js');
} catch (error) {
  console.error('❌ Failed to start server:', error.message);
  process.exit(1);
}
