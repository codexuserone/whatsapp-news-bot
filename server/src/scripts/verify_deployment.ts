
const { getSupabaseClient } = require('../db/supabase');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function monitorDeployment() {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('No DB connection');

    const TEST_GROUP_ID = '120363407220244757@g.us';
    console.log(`--- MONITORING DISPATCH TO ${TEST_GROUP_ID} ---`);

    // 1. Check if Target Exists
    const { data: targets } = await supabase.from('targets').select('id').eq('phone_number', TEST_GROUP_ID);
    if (!targets.length) {
        console.error('Target not found! Setup script might have failed?');
        return;
    }
    const targetId = targets[0].id;
    console.log(`Target ID: ${targetId}`);

    // 2. Poll for logs
    let attempts = 0;
    const maxAttempts = 24; // 2 minutes (every 5s)

    while (attempts < maxAttempts) {
        attempts++;

        // Check logs
        const { data: logs, error } = await supabase
            .from('message_logs')
            .select('id, status, error_message, sent_at, feed_item_id')
            .eq('target_id', targetId)
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) {
            console.error('Log fetch error:', error.message);
        } else if (logs && logs.length > 0) {
            const latest = logs[0];
            console.log(`[${new Date().toISOString()}] Latest Log Status: ${latest.status}`);

            if (['sent', 'delivered', 'read', 'played'].includes(String(latest.status || '').toLowerCase())) {
                console.log('SUCCESS: Message SENT!');
                console.log(`Sent At: ${latest.sent_at}`);
                return;
            } else if (latest.status === 'failed') {
                console.error('FAILURE: Message failed.');
                console.error('Error:', latest.error_message);
                return;
            }
        } else {
            console.log(`[${new Date().toISOString()}] No logs found yet... waiting for cron...`);
        }

        await new Promise(r => setTimeout(r, 5000));
    }

    console.error('TIMEOUT: No dispatch occurred within 2 minutes. Is the server running? Is cron active?');
}

monitorDeployment().catch(console.error);

export {};
