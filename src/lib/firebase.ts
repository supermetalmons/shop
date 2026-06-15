import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA3NTv_zfVYMB2VNORxbKg3rJUsiMXIhko';
const FIREBASE_FUNCTIONS_REGION = 'us-central1' as const;
const firebaseApiKey = (import.meta.env?.VITE_FIREBASE_API_KEY || '').trim() || DEFAULT_FIREBASE_API_KEY;

const firebaseConfig = {
  apiKey: firebaseApiKey,
  authDomain: 'mons-shop.firebaseapp.com',
  projectId: 'mons-shop',
  storageBucket: 'mons-shop.firebasestorage.app',
  messagingSenderId: '804781326988',
  appId: '1:804781326988:web:abeb4da8cfe43318a671a9',
};

export const firebaseApp =
  getApps().length === 0 && firebaseConfig.apiKey
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const auth = firebaseApp ? getAuth(firebaseApp) : undefined;
export const firestore = firebaseApp ? getFirestore(firebaseApp) : undefined;
export { FIREBASE_FUNCTIONS_REGION };
