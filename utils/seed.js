// utils/seed.js  — Populate the DB with sample data for local development
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User   = require('../models/User');
const ACUnit = require('../models/ACUnit');

const seed = async () => {
  await connectDB();

  // Wipe existing seed data
  await User.deleteMany({});
  await ACUnit.deleteMany({});
  console.log('🗑️  Cleared existing data');

  // Create a demo user
  const user = await User.create({
    name:     'Demo User',
    email:    'demo@auralink.io',
    password: 'password123',
  });
  console.log(`👤 Created user: ${user.email}`);

  // Create three virtual AC cards
  const units = await ACUnit.insertMany([
    {
      name:     'Master Bedroom AC',
      location: 'Master Bedroom',
      brand:    'Daikin',
      owner:    user._id,
      apiKey:   'esp_masterbed_key_0001',
      desiredState: { power: false, temperature: 24, mode: 'cool', fanSpeed: 'auto' },
    },
    {
      name:     'Living Room AC',
      location: 'Living Room',
      brand:    'Samsung',
      owner:    user._id,
      apiKey:   'esp_livingroom_key_0002',
      desiredState: { power: true,  temperature: 22, mode: 'cool', fanSpeed: 'high' },
    },
    {
      name:     'Home Office AC',
      location: 'Office',
      brand:    'LG',
      owner:    user._id,
      apiKey:   'esp_office_key_0003',
      desiredState: { power: false, temperature: 23, mode: 'fan',  fanSpeed: 'low' },
    },
  ]);

  await User.findByIdAndUpdate(user._id, { $push: { acUnits: { $each: units.map(u => u._id) } } });

  console.log(`❄️  Created ${units.length} AC units`);
  console.log('\n✅ Seed complete!\n');
  console.log('Demo credentials:');
  console.log('  Email:    demo@auralink.io');
  console.log('  Password: password123\n');

  process.exit(0);
};

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
