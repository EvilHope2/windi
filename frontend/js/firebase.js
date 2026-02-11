import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB9WKdwJ5Rcg64zMJgDee4XBvdyGoJemZA",
  authDomain: "windi-rg-121f8.firebaseapp.com",
  databaseURL: "https://windi-rg-121f8-default-rtdb.firebaseio.com",
  projectId: "windi-rg-121f8",
  storageBucket: "windi-rg-121f8.firebasestorage.app",
  messagingSenderId: "252797875505",
  appId: "1:252797875505:web:c4fe4f50c78f344a3dac10",
  measurementId: "G-F8JGX4SVQ5"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
