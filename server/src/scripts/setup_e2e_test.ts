
const { getSupabaseClient } = require('../db/supabase');
const path = require('path');
const dotenv = require('dotenv');

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const TEST_GROUP_ID = String(process.env.TEST_GROUP_ID || '').trim();
const E2E_FEED_URL = String(process.env.E2E_FEED_URL || process.env.TEST_FEED_URL || '').trim();
const E2E_TEMPLATE_NAME = String(process.env.E2E_TEMPLATE_NAME || 'E2E Test Template').trim();
const E2E_SCHEDULE_NAME = String(process.env.E2E_SCHEDULE_NAME || 'E2E Test Schedule (Immediate)').trim();
const E2E_FEED_NAME = String(process.env.E2E_FEED_NAME || 'E2E Test Feed').trim();

async function setupTestSchedule() {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('No DB connection');
    if (!TEST_GROUP_ID) throw new Error('TEST_GROUP_ID is required');
    if (!E2E_FEED_URL) throw new Error('E2E_FEED_URL (or TEST_FEED_URL) is required');

    console.log('--- SETTING UP E2E TEST SCHEDULE ---');

    // 1. Get/Create Feed
    let feedId;
    const { data: feeds } = await supabase.from('feeds').select('id, url').eq('url', E2E_FEED_URL).limit(1);

    if (feeds && feeds.length > 0) {
        feedId = feeds[0].id;
        console.log(`Found existing E2E feed: ${feedId}`);
        // Activate it
        await supabase.from('feeds').update({ active: true }).eq('id', feedId);
    } else {
        console.log('Creating new E2E feed...');
        const { data: newFeed, error } = await supabase.from('feeds').insert({
            url: E2E_FEED_URL,
            name: E2E_FEED_NAME,
            type: 'rss',
            active: true,
            fetch_interval: 300
        }).select().single();
        if (error) throw error;
        feedId = newFeed.id;
    }

    // 2. Get/Create Template
    let templateId;
    const { data: templates } = await supabase
        .from('templates')
        .select('id')
        .eq('name', E2E_TEMPLATE_NAME)
        .limit(1);
    if (templates && templates.length > 0) {
        templateId = templates[0].id;
        console.log(`Found existing E2E template: ${templateId}`);
    } else {
        const { data: newTemplate, error: templateError } = await supabase
            .from('templates')
            .insert({
                name: E2E_TEMPLATE_NAME,
                content: '*{{title}}*\\n\\n{{link}}',
                active: true,
                send_mode: 'image',
                send_images: true
            })
            .select()
            .single();
        if (templateError) throw templateError;
        templateId = newTemplate.id;
        console.log(`Created E2E template: ${templateId}`);
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

    // Clean old test schedules to avoid duplicates
    await supabase.from('schedules').delete().eq('name', E2E_SCHEDULE_NAME);

    console.log('Creating immediate schedule...');
    const { data: schedule, error: schError } = await supabase.from('schedules').insert({
        feed_id: feedId,
        target_ids: [targetId],
        delivery_mode: 'immediate',
        active: true,
        state: 'active',
        name: E2E_SCHEDULE_NAME,
        template_id: templateId
    }).select().single();

    if (schError) throw schError;

    console.log(`SUCCESS: Created Schedule ${schedule.id}`);
    console.log('Run the processor now to verify dispatch.');

    return { schedule, feedId, targetId };
}

setupTestSchedule().catch(console.error);

export {};
