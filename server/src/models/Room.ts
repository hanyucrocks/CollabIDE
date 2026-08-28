import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  { _id: false },
);

const roomSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    language: { type: String, required: true, default: 'javascript' },
    members: { type: [memberSchema], default: [] },
    // Shareable join secret. Rotatable, hence separate from _id.
    inviteToken: { type: String, required: true, unique: true },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Drives "rooms I'm a member of" lookups.
roomSchema.index({ 'members.userId': 1 });

export type Room = InferSchemaType<typeof roomSchema>;
export type RoomDoc = HydratedDocument<Room>;

export const RoomModel = model('Room', roomSchema);
