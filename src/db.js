const mongoose = require('mongoose');
const { mongoUri } = require('./config');

let memoryServer;

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (mongoose.connection.readyState === 2) {
    return mongoose.connection.asPromise();
  }

  const uri = mongoUri || (await createMemoryMongo());
  await mongoose.connect(uri, {
    autoIndex: true
  });

  console.log(`MongoDB connected: ${mongoose.connection.host}`);
  return mongoose.connection;
}

async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

async function createMemoryMongo() {
  if (!memoryServer) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
  }

  return memoryServer.getUri();
}

module.exports = {
  connectDB,
  disconnectDB,
  createMemoryMongo
};
