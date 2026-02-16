
const API_URL = 'https://whatsapp-news-bot-3-69qh.onrender.com';
const USER = 'anashreporter';
const PASS = 'HJkNHX0Fs9CJZ-i3HBdgl_bWzd9Ew_1o';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

async function fetchJson(endpoint) {
    try {
        const res = await fetch(`${API_URL}${endpoint}`, {
            headers: { 'Authorization': AUTH }
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

    // 1. Verify Targets
    const targets = await fetchJson('/api/targets');
    if (targets) {
        console.log(`\n✅ Targets: Found ${targets.length}`);
        const anashStatus = targets.find(t => t.phone_number === '120363404222439957@g.us');
        const feedGroup = targets.find(t => t.phone_number === '120363407220244757@g.us');
        const myStatus = targets.find(t => t.type === 'status');

        if (anashStatus) console.log(`   - Found Group: "${anashStatus.name}" (Active: ${anashStatus.active})`);
        else console.warn('   ⚠️ Missing Group: Anash Status');

        if (feedGroup) console.log(`   - Found Group: "${feedGroup.name}" (Active: ${feedGroup.active})`);
        else console.warn('   ⚠️ Missing Group: Feed for Anash WhatsApp');

        if (myStatus) console.log(`   - Found Status: "${myStatus.name}" (Type: ${myStatus.type}, Active: ${myStatus.active})`);
        else console.warn('   ⚠️ Missing Status Target');
    }

    // 2. Verify Schedules
    const schedules = await fetchJson('/api/schedules');
    if (schedules) {
        console.log(`\n✅ Schedules: Found ${schedules.length}`);
        const activeSchedules = schedules.filter(s => s.active && s.state === 'active');
        console.log(`   - Active Running Schedules: ${activeSchedules.length}`);

        activeSchedules.forEach(s => {
            console.log(`     * "${s.name}" (Next Run: ${s.next_run_at || 'Immediate/Pending'})`);
            if (!s.target_ids || s.target_ids.length === 0) {
                console.warn(`       ⚠️  WARNING: Schedule "${s.name}" has NO TARGETS!`);
            }
        });
    }

    // 3. Verify Logs
    const logs = await fetchJson('/api/logs?status=sent'); // Just check successful sends
    if (logs) {
        console.log(`\n✅ Direct Logs Check (Status: SENT): Found ${logs.length} recent entries`);
        const recent = logs.slice(0, 5);
        recent.forEach(l => {
            console.log(`   - [${l.sent_at}] Sent to "${l.target?.name || l.target_id}" (ID: ${l.id.slice(0, 8)}...)`);
        });
    } else {
        console.warn('\n⚠️ Could not fetch logs.');
    }

    console.log('\n--- Verification Complete ---');
}

main();
