import dotenv from 'dotenv';
import mongoose, { Mongoose } from 'mongoose';
import { Kafka } from 'kafkajs';

// Load environment variables
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const TARGET_EMAIL = 'dev.maniprithvi@gmail.com';
const userid = new mongoose.Types.ObjectId("68d3753f9f99d6b73ae2d991")

async function main() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI not set in environment or .env');
        process.exit(1);
    }

    console.log(`🗃️  Connecting to MongoDB...`, MONGO_URI);
    await mongoose.connect(MONGO_URI);

    const db = mongoose.connection.db;
    if (!db) {
        console.error('❌ Failed to get database connection');
        process.exit(1);
    }

    const user = await db.collection('User').findOne({ _id: userid });
    console.log('✅ Found user:', user ? user._id : 'null');

    if (!user) {
        console.error(`❌ User ${TARGET_EMAIL} not found in DB`);
        process.exit(1);
    }

    // Try multiple collection names just in case
    let social = await db.collection('socials').findOne({ userId: userid, provider: 'INSTAGRAM' });
    if (!social) {
        social = await db.collection('Social').findOne({ userId: userid, provider: 'INSTAGRAM' });
    }

    console.log('✅ Found social:', social);

    if (!social) {
        console.error(`❌ Instagram social account not found for user ${TARGET_EMAIL}`);
        process.exit(1);
    }
    console.log(`✅ Found Instagram social account ID: ${social.socialAccountId}`);

    console.log(`📦 Connecting to Kafka at ${KAFKA_BROKERS.join(',')}...`);
    const kafka = new Kafka({
        clientId: 'test-scheduler-instagram',
        brokers: KAFKA_BROKERS
    });

    const producer = kafka.producer();
    await producer.connect();
    console.log('✅ Kafka Producer connected.');

    // Mock device ID exclusively for testing this user's fetch flow
    const deviceId = 'test-device-' + user._id.toString();

    console.log('⏱️  Starting 1-minute interval to publish fetch request...');
    console.log('   (This bypasses the Redis active device check logic)');

    const publishJob = async () => {
        const payload = {
            deviceId: deviceId,
            trigger: 'scheduled',
            userId: user._id.toString()
        };

        try {
            await producer.send({
                topic: 'instagram-fetch-requests',
                messages: [{
                    key: deviceId,
                    value: JSON.stringify(payload)
                }]
            });
            console.log(`[${new Date().toISOString()}] 📤 Published fetch request to topic "instagram-fetch-requests" for ${TARGET_EMAIL}`);
        } catch (err) {
            console.error('❌ Failed to publish message:', err);
        }
    };

    // Run the job immediately the first time
    await publishJob();

    // Schedule the job to run every 60 seconds
    setInterval(publishJob, 600000);
}

main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
