
const { getSupabaseClient } = require('../db/supabase');
const path = require('path');
const dotenv = require('dotenv');

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const TEST_GROUP_ID = '120363407220244757@g.us';
const ANASH_FEED_URL = 'https://anash.org/feed/';

async function setupTestSchedule() {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('No DB connection');

    console.log('--- SETTING UP E2E TEST SCHEDULE ---');

    // 1. Get/Create Feed
    let feedId;
    const { data: feeds } = await supabase.from('feeds').select('id, url').eq('url', ANASH_FEED_URL).limit(1);

    if (feeds && feeds.length > 0) {
        feedId = feeds[0].id;
        console.log(`Found existing Anash feed: ${feedId}`);
        // Activate it
        await supabase.from('feeds').update({ active: true }).eq('id', feedId);
    } else {
        console.log('Creating new Anash feed...');
        const { data: newFeed, error } = await supabase.from('feeds').insert({
            url: ANASH_FEED_URL,
            name: 'Anash.org E2E Test',
            type: 'rss',
            active: true,
            fetch_interval_minutes: 5
        }).select().single();
        if (error) throw error;
        feedId = newFeed.id;
    }

    // 2. Create Target
    let targetId;
    const { data: targets } = await supabase.from('targets').select('id').eq('phone_number', TEST_GROUP_ID).limit(1);
    if (targets && targets.length > 0) {
        targetId = targets[0].id;
        console.log(`Found existing Test Group target: ${targetId}`);
    } else {
        console.log('Creating Test Group target...');
        const { data: newTarget, error } = await supabase.from('targets').insert({
            phone_number: TEST_GROUP_ID,
            name: 'E2E Test Group',
            type: 'group',
            active: true
        }).select().single();
        if (error) throw error;
        targetId = newTarget.id;
    }

    // 3. Create (or Reset) Immediate Schedule
    // We want a schedule that sends "Immediately" so we can trigger it.
    const scheduleName = 'E2E Test Schedule (Immediate)';

    // Clean old test schedules to avoid duplicates
    await supabase.from('schedules').delete().eq('name', scheduleName);

    console.log('Creating immediate schedule...');
    const { data: schedule, error: schError } = await supabase.from('schedules').insert({
        feed_id: feedId,
        target_ids: [targetId],
        delivery_mode: 'immediate',
        active: true,
        name: scheduleName,
        template_id: null // Use default simple template
    }).select().single();

    if (schError) throw schError;

    console.log(`SUCCESS: Created Schedule ${schedule.id}`);
    console.log('Run the processor now to verify dispatch.');

    return { schedule, feedId, targetId };
}

setupTestSchedule().catch(console.error);
