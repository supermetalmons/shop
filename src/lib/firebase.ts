import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { FRONTEND_DEPLOYMENT } from '../config/deployment';

const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA3NTv_zfVYMB2VNORxbKg3rJUsiMXIhko';
const firebaseApiKey = (import.meta.env?.VITE_FIREBASE_API_KEY || '').trim() || DEFAULT_FIREBASE_API_KEY;

const firebaseConfig = {
  apiKey: firebaseApiKey,
  authDomain: FRONTEND_DEPLOYMENT.firebase.authDomain,
  projectId: FRONTEND_DEPLOYMENT.firebase.projectId,
  storageBucket: FRONTEND_DEPLOYMENT.firebase.storageBucket,
  messagingSenderId: FRONTEND_DEPLOYMENT.firebase.messagingSenderId,
  appId: FRONTEND_DEPLOYMENT.firebase.appId,
};

export const firebaseApp =
  getApps().length === 0 && firebaseConfig.apiKey
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const auth = firebaseApp ? getAuth(firebaseApp) : undefined;
