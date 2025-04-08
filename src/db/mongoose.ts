import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI!; // Use environment variable

if (!MONGODB_URI) {
    throw new Error("Please define the MONGODB_URI environment variable inside .env.local");
}

let cached = (global as any).mongoose || { conn: null, promise: null };

export async function connectToDatabase() {
    if (cached.conn) return cached.conn;

    if (!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, {
            dbName: process.env.MONGODB_DB_NAME, // Optional: Define database name
            bufferCommands: false,
        }).then((mongoose) => mongoose);

    }

    cached.conn = await cached.promise;
    // console.log({ cached })
    console.log("connected..")
    return cached.conn;
}
