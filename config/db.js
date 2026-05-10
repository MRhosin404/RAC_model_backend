// config/db.js
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Mongoose 8.x — these are the only options still needed
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected. Attempting reconnect…');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected.');
    });
  } catch (err) {
    console.error(`❌ MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
