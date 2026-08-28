import mongoose from 'mongoose';
import { env } from '../config/env.ts';

export async function connectDb(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri);
  console.log(`[db] connected to ${mongoose.connection.name}`);

  mongoose.connection.on('error', (err) => console.error('[db] error', err));
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
}
