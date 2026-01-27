const mongoose = require('mongoose');

// Try with authSource=admin
const uri = 'mongodb+srv://anashreporter_db_user:2RN6wvmQqd1m42z1@cluster0.72fu0sn.mongodb.net/wabot?retryWrites=true&w=majority&authSource=admin';

console.log('Connecting to MongoDB with authSource=admin...');
mongoose.connect(uri)
  .then(() => {
    console.log('Connected successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Connection failed:', err.message);
    process.exit(1);
  });
