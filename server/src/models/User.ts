import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    /*
     * Optional: an account created through GitHub has no password. Exactly one
     * of passwordHash or githubId is always present, and an account can gain
     * the other later by linking.
     */
    passwordHash: { type: String, required: false },
    /* sparse so the unique index ignores password-only accounts. */
    githubId: { type: String, required: false, unique: true, sparse: true },
    // SHA-256 hashes of issued refresh tokens. One entry per active device/session,
    // which is what makes selective revocation (logout on one device) possible.
    refreshTokens: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type User = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<User>;

export const UserModel = model('User', userSchema);
