type BaileysModule = typeof import('@whiskeysockets/baileys');

let baileysPromise: Promise<BaileysModule> | null = null;

const loadBaileys = () => {
  if (!baileysPromise) {
    baileysPromise = import('@whiskeysockets/baileys');
  }
  return baileysPromise;
};

module.exports = { loadBaileys };
export {};
