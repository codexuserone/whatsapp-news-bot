import { loadApiAuth } from './lib/apiAuth.mjs';

const { apiUrl, authHeaders } = loadApiAuth();
const STATUS_GROUP_JID = String(process.env.STATUS_GROUP_JID || '120363404222439957@g.us').trim();
const FEED_GROUP_JID = String(process.env.FEED_GROUP_JID || '120363407220244757@g.us').trim();

async function fetchJson(endpoint) {
    try {
        const res = await fetch(`${apiUrl}${endpoint}`, {
            headers: authHeaders
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return await res.json();
    } catch (err) {
        console.error(`Failed to fetch ${endpoint}:`, err.message);
        return null;
    }
}

async function main() {
    console.log('--- E2E System Verification ---');
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`API_URL: ${apiUrl}`);

    // 1. Verify Targets
    const targets = await fetchJson('/api/targets');
    if (targets) {
        console.log(`\n[OK] Targets: Found ${targets.length}`);
        const anashStatus = targets.find(t => t.phone_number === STATUS_GROUP_JID);
        const feedGroup = targets.find(t => t.phone_number === FEED_GROUP_JID);
        const myStatus = targets.find(t => t.type === 'status');

        if (anashStatus) console.log(`   - Found Group: "${anashStatus.name}" (Active: ${anashStatus.active})`);
        else console.warn('   [WARN] Missing group target for STATUS_GROUP_JID');

        if (feedGroup) console.log(`   - Found Group: "${feedGroup.name}" (Active: ${feedGroup.active})`);
        else console.warn('   [WARN] Missing group target for FEED_GROUP_JID');

        if (myStatus) console.log(`   - Found Status: "${myStatus.name}" (Type: ${myStatus.type}, Active: ${myStatus.active})`);
        else console.warn('   [WARN] Missing status target');
    }

    // 2. Verify Schedules
    const schedules = await fetchJson('/api/schedules');
    if (schedules) {
        console.log(`\n[OK] Schedules: Found ${schedules.length}`);
        const activeSchedules = schedules.filter(s => s.active && s.state === 'active');
        console.log(`   - Active Running Schedules: ${activeSchedules.length}`);

        activeSchedules.forEach(s => {
            console.log(`     * "${s.name}" (Next Run: ${s.next_run_at || 'Immediate/Pending'})`);
            if (!s.target_ids || s.target_ids.length === 0) {
                console.warn(`       [WARN] Schedule "${s.name}" has no targets`);
            }
        });
    }

    // 3. Verify Logs
    const logs = await fetchJson('/api/logs?status=sent');
    if (logs) {
        console.log(`\n[OK] Direct Logs Check (Status: SENT): Found ${logs.length} recent entries`);
        const recent = logs.slice(0, 5);
        recent.forEach(l => {
            console.log(`   - [${l.sent_at}] Sent to "${l.target?.name || l.target_id}" (ID: ${l.id.slice(0, 8)}...)`);
        });
    } else {
        console.warn('\n[WARN] Could not fetch logs.');
    }

    console.log('\n--- Verification Complete ---');
}

main();
