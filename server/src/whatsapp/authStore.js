const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const AuthState = require('../models/AuthState');

const serialize = (data) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));
const deserialize = (data) => JSON.parse(JSON.stringify(data), BufferJSON.reviver);

const useMongoAuthState = async (name = 'default') => {
  let doc = await AuthState.findOne({ name });
  if (!doc) {
    doc = await AuthState.create({ name, creds: serialize(initAuthCreds()), keys: {} });
  }

  let state = {
    creds: deserialize(doc.creds),
    keys: deserialize(doc.keys || {})
  };

  const saveState = async () => {
    await AuthState.findOneAndUpdate(
      { name },
      { creds: serialize(state.creds), keys: serialize(state.keys), updatedAt: new Date() },
      { upsert: true }
    );
  };

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const store = state.keys[type] || {};
      for (const id of ids) {
        if (store[id]) {
          data[id] = deserialize(store[id]);
        }
      }
      return data;
    },
    set: async (data) => {
      state.keys = state.keys || {};
      Object.keys(data).forEach((category) => {
        state.keys[category] = state.keys[category] || {};
        Object.assign(state.keys[category], serialize(data[category]));
      });
      await saveState();
    }
  };

  return {
    state: { creds: state.creds, keys },
    saveCreds: async () => {
      state.creds = serialize(state.creds);
      state.creds = deserialize(state.creds);
      await saveState();
    },
    clearState: async () => {
      await AuthState.deleteOne({ name });
      state = { creds: initAuthCreds(), keys: {} };
    }
  };
};

module.exports = useMongoAuthState;
