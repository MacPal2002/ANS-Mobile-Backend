import * as admin from "firebase-admin";

// Inicjalizacja Admin SDK (musi być wywołana tylko raz)
admin.initializeApp();

// Eksportowanie instancji
export const db = admin.firestore();
export const auth = admin.auth();
export const firestore = admin.firestore;
