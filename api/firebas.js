import admin from 'firebase-admin';

// Initialize Firebase Admin using the Google Service Account JSON from Vercel Env
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export async function sendPushNotification(tokens, title, body) {
  if (!tokens || tokens.length === 0) return { success: false, message: 'No tokens provided' };
  
  const message = {
    notification: { title, body },
    tokens: tokens // Array of device tokens
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    return { success: true, successCount: response.successCount, failureCount: response.failureCount };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, error: error.message };
  }
}
