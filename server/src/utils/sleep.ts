const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = sleep;
export {};
