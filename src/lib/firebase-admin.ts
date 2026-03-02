import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

type FirebaseEnv = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  storageBucket: string;
};

let cachedEnv: FirebaseEnv | null | undefined;

function readFirebaseEnv(): FirebaseEnv | null {
  if (cachedEnv !== undefined) return cachedEnv;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (!projectId || !clientEmail || !privateKey || !storageBucket) {
    cachedEnv = null;
    return cachedEnv;
  }

  cachedEnv = {
    projectId,
    clientEmail,
    privateKey,
    storageBucket,
  };
  return cachedEnv;
}

function getFirebaseApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const env = readFirebaseEnv();
  if (!env) {
    throw new Error(
      "Missing Firebase configuration. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_STORAGE_BUCKET."
    );
  }

  return initializeApp({
    credential: cert({
      projectId: env.projectId,
      clientEmail: env.clientEmail,
      privateKey: env.privateKey,
    }),
    storageBucket: env.storageBucket,
  });
}

export function hasFirebaseAdminConfig(): boolean {
  return Boolean(readFirebaseEnv());
}

export function getFirebaseDb() {
  return getFirestore(getFirebaseApp());
}

export function getFirebaseBucket() {
  const app = getFirebaseApp();
  const bucketName = readFirebaseEnv()?.storageBucket;
  if (!bucketName) {
    throw new Error("Missing Firebase storage bucket configuration.");
  }
  return getStorage(app).bucket(bucketName);
}
