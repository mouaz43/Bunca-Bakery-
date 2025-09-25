// src/routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// List all raw materials (Rohwaren)
router.get('/products', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT code, name, base_unit, COALESCE(unit_cost,0) AS unit_cost, supplier_code
         FROM products
        ORDER BY name ASC`
    );
    res.render('products/index', {
      title: 'Rohwaren',
      products: rows
    });
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).send('Error loading products');
  }
});

module.exports = router;
