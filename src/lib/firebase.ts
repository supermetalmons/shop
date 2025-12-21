import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA3NTv_zfVYMB2VNORxbKg3rJUsiMXIhko';
const firebaseApiKey = (import.meta.env.VITE_FIREBASE_API_KEY || '').trim() || DEFAULT_FIREBASE_API_KEY;

const firebaseConfig = {
  apiKey: firebaseApiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseApp =
  getApps().length === 0 && firebaseConfig.apiKey
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const auth = firebaseApp ? getAuth(firebaseApp) : undefined;
