
const fs = require('fs');
const { execSync } = require('child_process');

console.log("--- Dependency Verification ---");

// 1. Check Root vs Server Deps
const rootPkg = require('../package.json');
const serverPkg = require('../server/package.json');

const rootDeps = new Set(Object.keys(rootPkg.dependencies || {}));
const serverDeps = Object.keys(serverPkg.dependencies || {});

const missing = serverDeps.filter(d => !rootDeps.has(d));

console.log(`Server dependencies missing in Root: ${missing.length}`);
if (missing.length > 0) {
    console.log("Missing:", missing.join(', '));
}

// 2. Check if node_modules exists in server
const serverModules = fs.existsSync('server/node_modules');
console.log(`server/node_modules exists: ${serverModules}`);

// 3. Dry Run Build Check
// If server/node_modules is missing, and we have missing deps, build SHOULD fail.
if (!serverModules && missing.length > 0) {
    console.log("PREDICTION: Build WILL FAIL because server-specific dependencies are missing.");
} else {
    console.log("PREDICTION: Build might succeed if modules are cached or hoisted.");
}
